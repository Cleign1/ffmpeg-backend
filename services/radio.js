import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { state, getRadioTime } from "../store.js";
import {
  loadPlaylist,
  getNextHourTracks,
  recalculateOffsets,
  saveEditedPlaylist,
} from "./playlist.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CONFIG } from "../config.js";

// --- CONFIGURATION ---
const BYTES_PER_TICK = 1764; // 10ms of audio at 44.1kHz 16-bit stereo
const BUFFER_SIZE = 4 * 1024; // ~0.045 seconds buffer for ultra-low latency

const getCrossfade = () => state.crossfade;

// --- STATE ---
const mixerInput = new PassThrough({ highWaterMark: BUFFER_SIZE });
const activeStreams = new Set();
state._activeStreams = activeStreams;

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

const normalizeCrossfade = (patch = {}) => {
  const base = { ...state.crossfade };
  if (patch.enabled !== undefined) base.enabled = !!patch.enabled;
  if (patch.preloadMs !== undefined)
    base.preloadMs = clamp(Number(patch.preloadMs) || 0, 0, 20000);
  if (patch.overlapMs !== undefined)
    base.overlapMs = clamp(Number(patch.overlapMs) || 0, -20000, 0);
  if (patch.fadeOutMs !== undefined)
    base.fadeOutMs = clamp(Number(patch.fadeOutMs) || 0, 0, 20000);
  if (patch.fadeInMs !== undefined)
    base.fadeInMs = clamp(Number(patch.fadeInMs) || 0, 0, 20000);
  return base;
};

const refreshActiveStreamsAfterCrossfadeUpdate = (cfg) => {
  const BPS = 44100 * 2 * 2;
  for (const stream of Array.from(activeStreams)) {
    if (!stream?.trackData) continue;
    const fadeStart = Math.max(
      0,
      (stream.trackData.mixPointMs - stream.trackData.cutInMs) / 1000,
    );
    const mixPointOffsetMs =
      (stream.trackData?.mixPointMs || stream.trackData?.mixPoint || 0) -
      (stream.trackData?.cutInMs || stream.trackData?.cutIn || 0);
    const overlapAwareMixSec = Math.max(
      0,
      (mixPointOffsetMs + cfg.overlapMs) / 1000,
    );
    stream.mixThreshold = overlapAwareMixSec * BPS;
    stream.triggerThreshold = Math.max(
      0,
      stream.mixThreshold - (cfg.preloadMs / 1000) * BPS,
    );
  }
};

const applyCrossfadeState = (patch) => {
  state.crossfade = normalizeCrossfade(patch);
  refreshActiveStreamsAfterCrossfadeUpdate(state.crossfade);
  state._broadcastState?.();
  state._broadcastStatus?.();
  return state.crossfade;
};

const CROSSFADE_PRESETS = {
  soft: {
    enabled: true,
    preloadMs: 4000,
    overlapMs: -2000,
    fadeOutMs: 2500,
    fadeInMs: 1200,
  },
  normal: {
    enabled: true,
    preloadMs: 3000,
    overlapMs: -1100,
    fadeOutMs: 3000,
    fadeInMs: 500,
  },
  aggressive: {
    enabled: true,
    preloadMs: 5000,
    overlapMs: -4000,
    fadeOutMs: 4500,
    fadeInMs: 2000,
  },
};

let currentTrackIndex = 0;
let isMerging = false;

// --- MASTER ENCODER & OUTPUT ---
const masterOutput = new PassThrough({ highWaterMark: 4 * 1024 });
let masterEncoderProc = null;

masterOutput.on("data", (chunk) => {
  for (const res of state.clients) res.write(chunk);
});

// Function to start/restart the FFmpeg Encoder
const startMasterEncoder = () => {
  if (masterEncoderProc) return;

  console.log("[Master] 🎙️ Starting Broadcast Encoder...");

  // -re flag is crucial: it tells FFmpeg to read input at native speed (1x)
  masterEncoderProc = ffmpeg(mixerInput)
    .inputOptions([
      "-f s16le",
      "-ar 44100",
      "-ac 2",
      "-fflags +nobuffer",
      "-flags low_delay",
      "-re",
    ])
    .outputOptions([
      "-c:a libmp3lame",
      "-b:a 192k",
      "-q:a 2",
      "-ar 44100",
      "-ac 2",
      "-f mp3",
      "-flush_packets 1",
      "-fflags +nobuffer",
      "-flags low_delay",
      "-max_delay 0",
      "-muxdelay 0",
      "-muxpreload 0",
    ]);

  masterEncoderProc.on("error", (err) => {
    console.error("[Master] 🚨 Encoder Error (Restarting...):", err.message);
    masterEncoderProc = null;
    setTimeout(startMasterEncoder, 1000);
  });

  masterEncoderProc.on("end", () => {
    console.warn("[Master] ⚠️ Encoder exited. Restarting...");
    masterEncoderProc = null;
    setTimeout(startMasterEncoder, 1000);
  });

  masterEncoderProc.pipe(masterOutput, { end: false });
};

// Start it immediately
startMasterEncoder();

// --- MIXER LOOP (WITH BACKPRESSURE) ---
const startMixerLoop = () => {
  const run = () => {
    // 1. Graceful Stop Check
    if (
      state.isBroadcasting &&
      activeStreams.size === 0 &&
      state.stopRequested
    ) {
      console.log("[Radio] 🌑 Broadcast finished gracefully.");
      state.isBroadcasting = false;
      state.isPaused = true;
      state.currentTrack = null;
      state.stopRequested = false;
      state._broadcastState?.();
    }

    // 2. Prepare Buffer
    const mixedBuffer = Buffer.alloc(BYTES_PER_TICK, 0);
    let hasActiveAudio = false;

    // 3. Mix Streams
    for (const stream of Array.from(activeStreams)) {
      if (Date.now() < stream.scheduledStartTime) continue;

      const chunk = stream.read(BYTES_PER_TICK);

      // --- 🛑 HANDLE STREAM FINISH ---
      if (!chunk) {
        if (stream.isFinished) {
          const title = stream.trackData.title;
          activeStreams.delete(stream); // Remove dead stream

          console.log(`[Radio] 🏁 Finished: "${title}"`);

          // Compute downstream buffer to avoid early UI highlight when data is still draining
          const bufferedTicks = mixerInput.writableLength / BYTES_PER_TICK;
          const drainDelayMs = Math.min(
            2000,
            Math.max(0, Math.round(bufferedTicks * 20)),
          );

          const promoteSolo = () => {
            if (activeStreams.size === 1) {
              const soloStream = activeStreams.values().next().value;
              console.log(
                `[Radio] 🎙️ Now Playing Solo: "${soloStream.trackData.title}"`,
              );
              // Update state to ensure "currentTrack" is definitely the solo one
              state.currentTrack = soloStream.trackData;
              state.currentStream = soloStream;
              state.radioStartTime =
                soloStream.actualStartTime ||
                soloStream.scheduledStartTime ||
                Date.now();
              state._broadcastStatus?.();
            } else if (activeStreams.size === 0) {
              state.currentTrack = null;
              state.currentStream = null;
              state.radioStartTime = 0;
              state._broadcastStatus?.();
            }
          };

          if (drainDelayMs > 0) {
            setTimeout(promoteSolo, drainDelayMs);
          } else {
            promoteSolo();
          }
        }
        continue;
      }
      // -------------------------------

      hasActiveAudio = true;

      if (!stream.hasStartedMixing) {
        stream.hasStartedMixing = true;
        stream.actualStartTime = Date.now();

        if (!state.stopRequested) {
          // Log the START of a new track
          if (
            state.currentTrack &&
            state.currentTrack.title !== stream.trackData.title
          ) {
            // Crossfade Start
            console.log(
              `[Radio] 🔀 Mixing In: "${stream.trackData.title}" (over "${state.currentTrack.title}")`,
            );
          } else {
            // Cold Start
            console.log(`[Radio] ▶️ Starting: "${stream.trackData.title}"`);
          }

          const isSoloStart = activeStreams.size === 1 || !state.currentTrack;

          // Only promote to current track when it is the sole audible stream.
          if (isSoloStart) {
            state.currentTrack = stream.trackData;
            state.currentStream = stream;
            state.radioStartTime = stream.actualStartTime;
            state.isBroadcasting = true;
            state._broadcastStatus?.();
          }
        }
      }

      stream.bytesPlayed += chunk.length;

      // Trigger Next Song
      if (
        !stream.nextTriggered &&
        stream.bytesPlayed >= stream.triggerThreshold
      ) {
        stream.nextTriggered = true;
        // 🛑 Block trigger if stopping
        if (!state.stopRequested) {
          const { enabled, overlapMs } = getCrossfade();
          const anchorStart =
            stream.actualStartTime || stream.scheduledStartTime || Date.now();
          const mixPointOffsetMs =
            stream.crossfadeTiming?.mixPointOffsetMs ??
            (stream.trackData?.mixPointMs || stream.trackData?.mixPoint || 0) -
              (stream.trackData?.cutInMs || stream.trackData?.cutIn || 0);
          const desiredStartMs = anchorStart + mixPointOffsetMs + overlapMs;
          const delay = enabled ? Math.max(0, desiredStartMs - Date.now()) : 0;
          stream.triggerNext?.(delay);
        } else {
          console.log(
            `[Stream] 🛑 Next trigger blocked for: ${stream.trackData.title}`,
          );
        }
      }

      // Audio Summing
      for (let i = 0; i < chunk.length; i += 2) {
        if (i + 1 >= mixedBuffer.length) break;
        let v = mixedBuffer.readInt16LE(i) + chunk.readInt16LE(i);
        if (v > 32767) v = 32767;
        if (v < -32768) v = -32768;
        mixedBuffer.writeInt16LE(v, i);
      }
    }

    // 4. WRITE WITH BACKPRESSURE
    const canContinue = mixerInput.write(mixedBuffer);

    if (canContinue) {
      setTimeout(run, 5);
    } else {
      mixerInput.once("drain", run);
    }
  };

  run();
};

startMixerLoop();

// --- PLAYLIST SOURCE ---
const getActivePlaylist = () => state.playlist; // Simplified: state.playlist is always the source

const setActivePlaylistFromPath = (fullPath) => {
  const basename = path.basename(fullPath);

  const success = loadPlaylist(fullPath);
  if (!success) return { success: false, error: "Failed to parse playlist" };

  state.activePlaylistId = fullPath;
  state.pendingPlaylistId = null;
  state.playbackMode = basename.startsWith("manual_") ? "manual" : "auto";
  currentTrackIndex = 0;
  state.stopRequested = false;
  state.playlistVersion = Date.now();
  state._broadcastPlaylist?.();
  state._broadcastStatus?.();
  return { success: true };
};

const queuePendingPlaylist = (fullPath) => {
  const basename = path.basename(fullPath);
  state.pendingPlaylistId = fullPath;
  console.log(`[Radio] ⏳ Pending playlist queued: ${basename}`);
  state._broadcastStatus?.();
  return { success: true, pending: true, pendingPlaylistId: basename };
};

export const cancelPendingPlaylist = () => {
  const hadPending = !!state.pendingPlaylistId;
  state.pendingPlaylistId = null;
  if (hadPending) {
    console.log("[Radio] ❎ Pending playlist switch cancelled.");
    state._broadcastStatus?.();
  }
  return { success: true, cancelled: hadPending };
};

const applyPendingPlaylist = (force = false) => {
  if (!state.pendingPlaylistId) return { success: false, applied: false };
  if (state.stopRequested && !force) return { success: false, applied: false };

  const fullPath = state.pendingPlaylistId;

  if (!fs.existsSync(fullPath)) {
    console.warn(`[Radio] ⚠️ Pending playlist not found: ${fullPath}`);
    state.pendingPlaylistId = null;
    return {
      success: false,
      applied: false,
      error: "Pending playlist missing",
    };
  }

  const result = setActivePlaylistFromPath(fullPath);
  if (!result.success) {
    console.warn(`[Radio] ⚠️ Failed to apply pending playlist: ${fullPath}`);
    return { success: false, applied: false, error: result.error };
  }

  console.log(
    `[Radio] ✅ Applied pending playlist: ${path.basename(fullPath)}`,
  );
  return { success: true, applied: true };
};

const applyPendingPlaylistIfAny = () => {
  const res = applyPendingPlaylist(false);
  return !!res.applied;
};

// --- CORE PLAYBACK LOOP ---
const playNextTrack = (delayMs = 0) => {
  if (state.isPaused || state.stopRequested) return;

  applyPendingPlaylistIfAny();

  // ---------------------------------------------------------
  // DYNAMIC MERGE LOGIC
  // ---------------------------------------------------------
  // Only merge if we are in AUTO mode (Scheduler)
  if (
    state.playbackMode === "auto" &&
    !isMerging &&
    state.playlist.length > 0
  ) {
    const tracksRemaining = state.playlist.length - currentTrackIndex;

    // If we are down to the last 5 songs (or fewer)
    if (tracksRemaining <= 5) {
      console.log(
        `[Radio] ⚠️ Approaching end of hour (${tracksRemaining} tracks left). Fetching next...`,
      );
      isMerging = true;

      const nextHour = getNextHourTracks();

      if (nextHour && nextHour.length > 0) {
        // 1. Keep the current song and whatever is left after it
        const leftovers = state.playlist.slice(currentTrackIndex);

        // 2. Create the new Master Playlist
        state.playlist = [...leftovers, ...nextHour];

        // 3. Reset index to 0
        currentTrackIndex = 0;

        // 4. Update Times & Notify Frontend
        recalculateOffsets();
        state.playlistVersion = Date.now();
        state._broadcastPlaylist?.();

        console.log(
          `[Radio] ✅ Merge Complete. New Playlist Size: ${state.playlist.length}`,
        );
      } else {
        console.warn("[Radio] ⚠️ No next hour tracks found yet.");
      }

      setTimeout(() => (isMerging = false), 10000);
    }
  }
  // ---------------------------------------------------------

  // Retrieve the (potentially updated) playlist
  const playlist = getActivePlaylist();

  // Safety check: Filter out missing files
  const playable = playlist.filter((t) => fs.existsSync(t.path));

  if (!playable.length) {
    console.error("[Radio] ❌ No playable tracks found. Retrying in 5s...");
    state.isBroadcasting = false;
    return setTimeout(() => playNextTrack(0), 5000);
  }

  // End of Playlist Check
  if (currentTrackIndex >= playable.length) {
    console.log("[Radio] 🔁 Playlist ended. looping to start.");
    currentTrackIndex = 0;

    // If we are in AUTO mode and run dry, try to reload fresh content
    if (state.playbackMode === "auto") {
      loadPlaylist();
    }
    return playNextTrack(0);
  }

  // Play the track at the current index
  playFile(playable[currentTrackIndex], delayMs);
};

// --- FILE PLAYER ---
const playFile = (track, delayMs) => {
  // 1. Destructure fadeInMs (Default to 2000ms if not in store)
  const {
    enabled,
    preloadMs,
    fadeOutMs,
    overlapMs,
    fadeInMs = 2000,
  } = getCrossfade();

  const playDuration = (track.cutOutMs - track.cutInMs) / 1000;
  const mixPointOffsetMs =
    (track.mixPointMs || track.mixPoint || 0) -
    (track.cutInMs || track.cutIn || 0);
  const fadeStartSec = Math.max(0, mixPointOffsetMs / 1000);
  const fadeOutDuration = enabled ? fadeOutMs / 1000 : 0;
  const fadeInDuration = enabled ? fadeInMs / 1000 : 0;
  // Start fade-out earlier by the overlap amount so decay begins before mix point
  const fadeOutStart = Math.max(0, (mixPointOffsetMs + overlapMs) / 1000);

  const cmd = ffmpeg(track.path)
    .audioCodec("pcm_s16le")
    .format("s16le")
    .audioChannels(2)
    .audioFrequency(44100);

  if (track.cutInMs > 0) cmd.seekInput(track.cutInMs / 1000);
  if (playDuration > 0) cmd.duration(playDuration);

  // --- FILTERS ---
  const filters = ["loudnorm=I=-16:TP=-1.5:LRA=11"];

  if (fadeOutDuration > 0.05) {
    filters.push(
      `afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration}:curve=iqsin`,
    );
  }

  if (fadeInDuration > 0.05) {
    filters.push(`afade=t=in:st=0:d=${fadeInDuration}:curve=iqsin`);
  }

  cmd.audioFilters(filters);

  const pcm = cmd.pipe(new PassThrough({ highWaterMark: 128 * 1024 }));

  pcm.trackData = track;
  pcm.bytesPlayed = 0;
  pcm.scheduledStartTime = Date.now() + delayMs;
  pcm.actualStartTime = null;
  pcm.ffmpegProc = cmd;

  const BPS = 44100 * 2 * 2;
  const overlapAwareMixSec = Math.max(0, (mixPointOffsetMs + overlapMs) / 1000);
  pcm.mixThreshold = overlapAwareMixSec * BPS;
  pcm.triggerThreshold = Math.max(
    0,
    pcm.mixThreshold - (preloadMs / 1000) * BPS,
  );
  pcm.crossfadeTiming = {
    mixPointOffsetMs,
    fadeStartSec,
    overlapAwareMixSec,
  };
  pcm.nextTriggered = false;
  pcm.isFinished = false;
  pcm.hasStartedMixing = false;

  pcm.triggerNext = (nextDelay) => {
    currentTrackIndex++;
    playNextTrack(nextDelay);
  };

  pcm.on("end", () => (pcm.isFinished = true));
  cmd.on("error", (err) => {
    if (!err.message.includes("SIGKILL")) {
      console.error("[FFmpeg]", err.message);
    }
    pcm.isFinished = true;
  });

  console.log(`[Radio] Loading: ${track.title}`);
  pcm.once("readable", () => activeStreams.add(pcm));
};

// =======================
// PUBLIC CONTROL API
// =======================

export const startRadio = () => {
  console.log("[Radio] 🎛️ Engine Initialized. Waiting for 'Start' command...");
  startMasterEncoder();
  loadPlaylist(); // Initial Load (Auto)
  state._broadcastPlaylist?.();
  state._broadcastStatus?.();
};

export const restartRadio = () => {
  console.log("[Radio] 🔄 Restarting...");
  startMasterEncoder();

  state.isPaused = true;
  state.isBroadcasting = false;
  state.stopRequested = false;

  activeStreams.forEach((s) => {
    if (s.ffmpegProc) s.ffmpegProc.kill("SIGKILL");
    s.destroy();
  });
  activeStreams.clear();

  currentTrackIndex = 0;

  // Reload current source
  if (state.activePlaylistId) {
    loadPlaylist(state.activePlaylistId);
  } else {
    loadPlaylist();
  }

  state.isPaused = false;
  playNextTrack(0);
};

// 🛑 STOP AFTER CURRENT
export const stopAfterCurrent = () => {
  console.log("[Radio] ✋ Stopping after current track...");
  state.stopRequested = true;

  const streams = Array.from(activeStreams);
  streams.sort((a, b) => a.scheduledStartTime - b.scheduledStartTime);

  if (streams.length === 0) return;

  const keeperStream = streams[0];
  const streamsToKill = streams.slice(1);

  streamsToKill.forEach((s) => {
    console.log(`[Radio] 🧹 Killing NEXT track: ${s.trackData?.title}`);
    if (s.ffmpegProc) s.ffmpegProc.kill("SIGKILL");
    s.destroy();
    activeStreams.delete(s);
  });

  if (keeperStream) {
    console.log(`[Radio] ⏳ Letting finish: ${keeperStream.trackData?.title}`);
    keeperStream.nextTriggered = true;
    keeperStream.triggerNext = null;
    state.currentStream = keeperStream;
    state.currentTrack = keeperStream.trackData;
  }
};

export function stopPlayback(force = false) {
  if (!force && activeStreams.size > 0) {
    console.log(
      "[Radio] ⚠️ Guarded stop requested; finishing current track before stopping.",
    );
    stopAfterCurrent();
    return { guarded: true };
  }

  console.log("[Radio] 🛑 HARD STOP: Killing all active audio streams...");

  activeStreams.forEach((stream) => {
    if (stream.ffmpegProc) {
      try {
        stream.ffmpegProc.kill("SIGKILL");
      } catch (e) {
        console.error("Error killing stream process:", e);
      }
    }
    stream.destroy();
  });

  activeStreams.clear();

  state.isPaused = true;
  state.isBroadcasting = false;
  state.currentTrack = null;
  state.stopRequested = false;
  state._broadcastStatus?.();
}

export const nextTrack = () => {
  state.allowAutoStart = true;
  state.stopRequested = false;
  stopPlayback(true);
  currentTrackIndex++;
  state.isPaused = false;
  playNextTrack(0);
};

export const restartCurrentTrack = () => {
  console.log("[Radio] 🔁 Restarting current track...");
  stopPlayback(true);
  state.isPaused = false;
  state.stopRequested = false;
  playNextTrack(0);
  state._broadcastState?.();
};

export const setCrossfadeConfig = (patch = {}) => {
  console.log("[Radio] 🎚️ Updating crossfade config", patch);
  const updated = applyCrossfadeState(patch);
  return { success: true, crossfade: updated };
};

export const enableCrossfade = (enabled) => {
  console.log(`[Radio] 🎚️ Crossfade ${enabled ? "enabled" : "disabled"}`);
  const updated = applyCrossfadeState({ enabled });
  return { success: true, crossfade: updated };
};

export const applyCrossfadePreset = (presetName) => {
  const key = `${presetName}`.toLowerCase();
  const preset = CROSSFADE_PRESETS[key];
  if (!preset) return { success: false, error: "Unknown preset" };
  console.log(`[Radio] 🎚️ Applying preset: ${key}`);
  const updated = applyCrossfadeState(preset);
  return { success: true, crossfade: updated, preset: key };
};

// --- NEW: Switch Playlist (Safe) ---
export const switchPlaylist = (playlistId) => {
  console.log(`[Radio] 🔀 Switching to playlist: ${playlistId}`);

  const fullPath = path.join(CONFIG.DATA_DIR, playlistId);
  if (!fs.existsSync(fullPath))
    return { success: false, error: "Playlist file not found" };

  if (state.isBroadcasting && activeStreams.size > 0 && !state.stopRequested) {
    return queuePendingPlaylist(fullPath);
  }

  return setActivePlaylistFromPath(fullPath);
};

export const queuePlaylistSwitch = (playlistId) => {
  const fullPath = path.join(CONFIG.DATA_DIR, playlistId);
  if (!fs.existsSync(fullPath))
    return { success: false, error: "Playlist file not found" };
  return queuePendingPlaylist(fullPath);
};

export const applyPendingPlaylistNow = () => applyPendingPlaylist(true);

// --- NEW FEATURE: Play By ID ---
export const playTrackById = (uuid) => {
  const playlist = getActivePlaylist();
  const index = playlist.findIndex((t) => t.uuid === uuid);

  if (index === -1) {
    return { success: false, error: "Track UUID not found in active playlist" };
  }

  console.log(`[Radio] ⏭️ Skipping to UUID: ${uuid} (Index: ${index})`);

  state.allowAutoStart = true;
  state.stopRequested = false;

  stopPlayback(true);

  currentTrackIndex = index;
  state.isPaused = false;

  playNextTrack(0);
  state._broadcastState?.();

  return { success: true };
};
