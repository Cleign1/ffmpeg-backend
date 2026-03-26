import { Server } from "socket.io";
import { state } from "../store.js";
import {
  restartRadio,
  stopPlayback,
  stopAfterCurrent,
  nextTrack,
  restartCurrentTrack,
  switchPlaylist,
  queuePlaylistSwitch,
  cancelPendingPlaylist,
  applyPendingPlaylistNow,
  playTrackById,
  setCrossfadeConfig,
  enableCrossfade,
  applyCrossfadePreset,
} from "./radio.js";
import { getLibrary } from "./library.js";
import {
  listPlaylists,
  createManualPlaylist,
  saveManualPlaylist,
  deletePlaylist,
  loadPlaylist,
  getNextHourTracks,
  recalculateOffsets,
  readPlaylist,
  clonePlaylist,
} from "./playlist.js";
import path from "path";
import { CONFIG } from "../config.js";
import { validateAudioFile } from "../utils/audioValidator.js";
import { downloadMissingSongs } from "../utils/downloadSong.js";
import { initializeLogger, getLogBuffer } from "../utils/logger.js";
import fs from "fs";
import { refreshLibrary } from "./library.js";
import { buildRealMusicBed } from "../utils/realTransitionBuilder.js";
import { listVoiceTracks } from "../utils/listVoiceTracks.js";

const requireEditorSocketAuth = (socket, payloadToken, ack) => {
  const required = CONFIG.SOCKET_AUTH_TOKEN;
  if (!required) return true;

  const handshakeToken =
    socket.handshake?.auth?.editorToken ||
    socket.handshake?.auth?.token ||
    socket.handshake?.headers?.["x-editor-token"] ||
    socket.handshake?.headers?.["x-editor-auth"];

  const provided = (payloadToken || handshakeToken || "").trim();
  if (provided && provided === required) return true;

  if (typeof ack === "function") {
    ack({ ok: false, error: "Unauthorized" });
  }
  return false;
};

export const startControlSocket = (httpServer) => {
  // 1. Initialize Socket.io
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  // Initialize logger to broadcast console output
  initializeLogger((logEntry) => {
    io.emit("server:log", logEntry);
  });

  // --- BROADCASTERS ---

  // A. Broadcast Playlist
  const broadcastPlaylist = () => {
    io.emit("playlist_update", state.playlist || []);
  };

  // B. Broadcast Status
  const broadcastState = () => {
    const activeTrackId = state.currentTrack ? state.currentTrack.uuid : null;

      const statusPayload = {
        playing: !state.isPaused && !state.stopRequested,
        mode: state.playbackMode === "auto" ? "AUTO" : "MANUAL",
        isPlaying: state.isBroadcasting,
        currentTrack: state.currentTrack || null,
        activeTrackId: activeTrackId,
        startedAt: state.radioStartTime || 0,
        currentStreamStart:
          state.currentStream?.actualStartTime ||
          state.currentStream?.scheduledStartTime ||
          0,
        listeners: state.clients ? state.clients.size : 0,
        activePlaylistId: state.activePlaylistId
          ? path.basename(state.activePlaylistId)
          : null,
        pendingPlaylistId: state.pendingPlaylistId
          ? path.basename(state.pendingPlaylistId)
          : null,
        crossfade: state.crossfade,
        crossfadeGraphical: state.crossfadeGraphical,
        isStopping: state.stopRequested,
      };

    io.emit("state", statusPayload);
    io.emit("status_update", statusPayload);
    io.emit("player:state", statusPayload);
  };

  const broadcastStationInfo = () => {
    io.emit(
      "radio_channel_info",
      state.stationInfo || {
        network_code: "N/A",
        network_id: 0,
        local_code: "N/A",
        country_code: "N/A",
      },
    );
  };

  // C. Broadcast Logs
  const broadcastLog = (logEntry) => {
    io.emit("server:log", logEntry);
  };

  const broadcastCrossfadeGraphical = () => {
    io.emit("crossfade:graphical:state", state.crossfadeGraphical);
  };

  // --- ATTACH TO STATE ---
  state._broadcastPlaylist = broadcastPlaylist;
  state._broadcastState = broadcastState;
  state._broadcastStatus = broadcastState;
  state._broadcastStationInfo = broadcastStationInfo;
  state._broadcastCrossfadeGraphical = broadcastCrossfadeGraphical;

  // --- CONNECTION HANDLER ---
  io.on("connection", (socket) => {
    console.log("[Socket.IO] 🔌 Client Connected:", socket.id);

    const safeAck = (arg1, arg2, response) => {
      const ack =
        typeof arg1 === "function"
          ? arg1
          : typeof arg2 === "function"
            ? arg2
            : null;
      if (ack) ack(response);
    };

    // --- ON CONNECT: Send Data Immediately ---
    socket.emit("listeners", state.clients ? state.clients.size : 0);
    socket.emit("playlist_update", state.playlist || []);
    socket.emit("radio_channel_info", state.stationInfo || {});
    socket.emit("crossfade:graphical:state", state.crossfadeGraphical);

    // Send recent logs to new client
    const recentLogs = getLogBuffer();
    socket.emit("server:log_history", recentLogs);

    broadcastState();

    // ===========================
    //       NEW API HANDLERS
    // ===========================

    // 1. LIBRARY
    socket.on("library:list", async (ack) => {
      const lib = await getLibrary();
      if (typeof ack === "function") ack({ ok: true, library: lib });
    });

    socket.on("library:list_voice_tracks", async (payload, ack) => {
      try {
        const files = listVoiceTracks();
        if (typeof ack === "function") ack({ ok: true, tracks: files });
      } catch (err) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Failed to list voice tracks" });
      }
    });

    socket.on("library:refresh", async (payload, ack) => {
      try {
        const refreshedLibrary = await refreshLibrary();
        io.emit("library:update", refreshedLibrary);
        if (typeof ack === "function") {
          ack({ ok: true, library: refreshedLibrary });
        }
      } catch (error) {
        console.error("[Socket] library:refresh error:", error);
        if (typeof ack === "function") {
          ack({ ok: false, error: "Failed to refresh library" });
        }
      }
    });

    // Bridge: send a track from music server to audio editor
    socket.on("editor:push_track", async (payload, ack) => {
      if (!requireEditorSocketAuth(socket, payload?.token, ack)) return;

      if (!payload || !payload.filename) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing filename" });
        return;
      }

      try {
        const filename = path.basename(payload.filename);
        if (
          filename.includes("..") ||
          filename.includes("/") ||
          filename.includes("\\")
        ) {
          if (typeof ack === "function")
            ack({ ok: false, error: "Invalid filename" });
          return;
        }

        const audioId =
          payload.id || path.basename(filename, path.extname(filename));
        const filePath = path.join(CONFIG.SONGS_DIR, filename);

        if (!fs.existsSync(filePath)) {
          if (typeof ack === "function")
            ack({ ok: false, error: "File not found" });
          return;
        }

        const health = await validateAudioFile(filePath);
        if (!health.isHealthy) {
          if (typeof ack === "function")
            ack({ ok: false, error: "File failed validation" });
          return;
        }

        const url = `/api/preview/audio/${encodeURIComponent(filename)}`;
        const trackPayload = {
          id: audioId,
          filename,
          url,
          metadata: health.metadata || null,
        };

        io.emit("editor:ingest", trackPayload);
        if (typeof ack === "function") ack({ ok: true, track: trackPayload });
      } catch (error) {
        console.error("[Socket] editor:push_track error:", error);
        if (typeof ack === "function")
          ack({ ok: false, error: "Failed to push track" });
      }
    });

    // Bridge: notify when editor saves/overwrites and refresh library
    socket.on("editor:saved", async (payload, ack) => {
      if (!requireEditorSocketAuth(socket, payload?.token, ack)) return;
      try {
        const refreshedLibrary = await refreshLibrary();
        io.emit("library:update", refreshedLibrary);
        io.emit("editor:updated", payload || {});
        if (typeof ack === "function")
          ack({ ok: true, laibrary: refreshedLibrary });
      } catch (error) {
        console.error("[Socket] editor:saved refresh error:", error);
        if (typeof ack === "function")
          ack({ ok: false, error: "Failed to refresh library" });
      }
    });

    // 2. FILE PREVIEW & HEALTH CHECK
    socket.on("preview:health", async (payload, ack) => {
      if (!payload || !payload.filename) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing filename" });
        return;
      }

      try {
        const filePath = path.join(CONFIG.SONGS_DIR, payload.filename);
        const healthCheck = await validateAudioFile(filePath);

        if (typeof ack === "function") {
          ack({
            ok: true,
            isHealthy: healthCheck.isHealthy,
            error: healthCheck.error || null,
            errorCode: healthCheck.errorCode || null,
            metadata: healthCheck.metadata || null,
          });
        }
      } catch (error) {
        console.error("Health check error:", error);
        if (typeof ack === "function") {
          ack({
            ok: false,
            isHealthy: false,
            error: "Internal server error during health check",
            errorCode: "SERVER_ERROR",
          });
        }
      }
    });

    socket.on("preview:metadata", async (payload, ack) => {
      if (!payload || !payload.filename) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing filename" });
        return;
      }

      try {
        const filePath = path.join(CONFIG.SONGS_DIR, payload.filename);
        const healthCheck = await validateAudioFile(filePath);

        if (!healthCheck.isHealthy) {
          if (typeof ack === "function") {
            ack({
              ok: false,
              error: healthCheck.error,
              errorCode: healthCheck.errorCode,
            });
          }
          return;
        }

        if (typeof ack === "function") {
          ack({
            ok: true,
            metadata: healthCheck.metadata,
          });
        }
      } catch (error) {
        console.error("Metadata fetch error:", error);
        if (typeof ack === "function") {
          ack({
            ok: false,
            error: "Failed to fetch metadata",
          });
        }
      }
    });

    socket.on("preview:get_audio_url", (payload, ack) => {
      if (!payload || !payload.filename) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing filename" });
        return;
      }

      try {
        const filePath = path.join(CONFIG.SONGS_DIR, payload.filename);

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          if (typeof ack === "function") {
            ack({ ok: false, error: "File not found" });
          }
          return;
        }

        // Return URL path for streaming
        if (typeof ack === "function") {
          ack({
            ok: true,
            url: `/api/preview/audio/${encodeURIComponent(payload.filename)}`,
          });
        }
      } catch (error) {
        console.error("Get audio URL error:", error);
        if (typeof ack === "function") {
          ack({
            ok: false,
            error: "Failed to get audio URL",
          });
        }
      }
    });

    // 3. PLAYLIST MANAGEMENT
    socket.on("playlist:list", (ack) => {
      if (typeof ack === "function")
        ack({ ok: true, playlists: listPlaylists() });
    });

    // 4. FUTURE PLAYLIST GENERATION
    socket.on("playlist:generate_future", async (payload, ack) => {
      if (!payload || !payload.targetDateTime) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing targetDateTime" });
        return;
      }

      try {
        const { syncMetadata } = await import("./metadata.js");
        const { extractSongsFromData } = await import("./scheduler.js");
        const targetDate = new Date(payload.targetDateTime);

        console.log(
          `[Socket] 📅 Generating future playlist for: ${targetDate.toLocaleString()}`,
        );

        // Fetch playlist data from API for the target time
        const playlistData = await syncMetadata(targetDate);

        if (!playlistData) {
          if (typeof ack === "function") {
            ack({
              ok: false,
              error: "No playlist data available for this time",
            });
          }
          return;
        }

        // Parse the raw data to get details array
        let detailsArray = [];
        let parsedData = playlistData;

        // Unwrap array if needed
        if (Array.isArray(parsedData) && parsedData.length > 0) {
          parsedData = parsedData[0];
        }

        // Unwrap dynamic hour key
        const keys = Object.keys(parsedData);
        if (keys.length === 1 && !isNaN(parseInt(keys[0]))) {
          parsedData = parsedData[keys[0]];
        }

        // Extract details
        if (parsedData.playlist && parsedData.playlist.details) {
          detailsArray = Array.isArray(parsedData.playlist.details)
            ? parsedData.playlist.details
            : Object.values(parsedData.playlist.details);
        } else if (parsedData.details) {
          detailsArray = Array.isArray(parsedData.details)
            ? parsedData.details
            : Object.values(parsedData.details);
        } else if (Array.isArray(parsedData)) {
          detailsArray = parsedData;
        }

        if (detailsArray.length === 0) {
          if (typeof ack === "function") {
            ack({ ok: false, error: "Generated playlist is empty" });
          }
          return;
        }

        // Extract songs for filename info
        const songList = extractSongsFromData(playlistData);

        // Format playlist with full metadata
        const formattedPlaylist = detailsArray.map((item, index) => {
          const songInfo = songList[index] || {};
          const cutIn = parseInt(item.cutIn || 0);
          const cutOut = parseInt(item.cutOut || 10000000);
          const duration = Math.ceil((cutOut - cutIn) / 1000);

          return {
            position: index + 1,
            title: item.title || "Unknown Title",
            artist: item.artist || "Unknown Artist",
            filename:
              songInfo.filename_as ||
              item.filename_as ||
              item.fileName ||
              "Unknown",
            sourceFileName: item.fileName || item.preview_filename || "", // For downloading
            duration: duration || 0,
            category: item.bc_category || "Music",
            cutIn: cutIn,
            cutOut: cutOut,
            mixPoint: parseInt(item.mix_point_pr_ev || 0),
            uuid: item.uuid || "",
          };
        });

        if (typeof ack === "function") {
          ack({
            ok: true,
            playlist: formattedPlaylist,
            targetTime: targetDate.toISOString(),
            totalTracks: formattedPlaylist.length,
          });
        }
      } catch (error) {
        console.error("[Socket] Error generating future playlist:", error);
        if (typeof ack === "function") {
          ack({
            ok: false,
            error: error.message || "Failed to generate playlist",
          });
        }
      }
    });

    socket.on("playlist:read", (payload, ack) => {
      if (!payload || !payload.id) {
        if (typeof ack === "function") ack({ ok: false, error: "Missing ID" });
        return;
      }
      const result = readPlaylist(payload.id);
      if (typeof ack === "function")
        ack(
          result.success
            ? { ok: true, tracks: result.tracks }
            : { ok: false, error: result.error },
        );
    });

    socket.on("playlist:clone", (payload, ack) => {
      if (!payload || !payload.sourceId || !payload.newName) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing params" });
        return;
      }
      const result = clonePlaylist(payload.sourceId, payload.newName);
      if (typeof ack === "function")
        ack(
          result.success
            ? { ok: true, id: result.id }
            : { ok: false, error: result.error },
        );
      io.emit("playlists:updated");
    });

    socket.on("playlist:create", (payload, ack) => {
      if (!payload || !payload.name) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing name" });
        return;
      }
      const result = createManualPlaylist(
        payload.name,
        payload.sourceTracks || [],
      );
      if (typeof ack === "function")
        ack(
          result.success
            ? { ok: true, id: result.id }
            : { ok: false, error: result.error },
        );
      // Broadcast list update to all (if we had a list update event, otherwise client polls)
      io.emit("playlists:updated"); // Let's add this event
    });

    socket.on("playlist:delete", (payload, ack) => {
      if (!payload || !payload.id) {
        if (typeof ack === "function") ack({ ok: false, error: "Missing ID" });
        return;
      }
      const result = deletePlaylist(payload.id);
      if (typeof ack === "function")
        ack(result.success ? { ok: true } : { ok: false, error: result.error });
      io.emit("playlists:updated");
    });

    socket.on("playlist:update_manual", (payload, ack) => {
      if (!payload || !payload.id || !payload.tracks) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Invalid payload" });
        return;
      }

      // 1. Save to Disk
      const result = saveManualPlaylist(payload.id, payload.tracks);

      if (result.success) {
        // 2. Check if this is the ACTIVE playlist
        const activeId = state.activePlaylistId
          ? path.basename(state.activePlaylistId)
          : null;

        if (activeId === payload.id) {
          console.log(`[Socket] 📝 Updating ACTIVE playlist: ${activeId}`);
          // Reload logic
          const reloaded = loadPlaylist(state.activePlaylistId);
          if (reloaded) {
            state.playlistVersion = Date.now();
            broadcastPlaylist();
          }
        }

        if (typeof ack === "function") ack({ ok: true });
      } else {
        if (typeof ack === "function") ack({ ok: false, error: result.error });
      }
    });

    // Preload and append the next hour's playlist when the frontend requests it (Socket-only)
    socket.on("playlist:preload_next_hour", (ack) => {
      try {
        const nextTracks = getNextHourTracks();

        if (!nextTracks || nextTracks.length === 0) {
          if (typeof ack === "function")
            ack({ ok: false, error: "Next-hour playlist not found" });
          return;
        }

        // De-duplicate by UUID to avoid double-append if backend auto-merges later
        const existing = new Set((state.playlist || []).map((t) => t.uuid));
        const uniqueTracks = nextTracks.filter((t) => !existing.has(t.uuid));

        if (uniqueTracks.length === 0) {
          if (typeof ack === "function")
            ack({ ok: true, appended: 0, alreadyLoaded: true });
          return;
        }

        state.playlist = [...state.playlist, ...uniqueTracks];
        recalculateOffsets();
        state.playlistVersion = Date.now();

        // Broadcast to all listeners so tables update immediately
        broadcastPlaylist();

        if (typeof ack === "function") {
          ack({
            ok: true,
            appended: uniqueTracks.length,
            playlistLength: state.playlist.length,
            tracks: uniqueTracks,
          });
        }
      } catch (error) {
        console.error("[Socket] Preload next hour failed:", error);
        if (typeof ack === "function")
          ack({ ok: false, error: error.message || "Unknown error" });
      }
    });

    // Save playlist (used by Fetch Playlist feature)
    socket.on("playlist:save", async (payload, ack) => {
      if (!payload || !payload.id || !payload.tracks) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Invalid payload" });
        return;
      }

      console.log(
        `[Socket] 💾 Saving playlist: ${payload.id} with ${payload.tracks.length} tracks`,
      );

      // 1. Save to Disk
      const result = saveManualPlaylist(payload.id, payload.tracks);

      if (result.success) {
        console.log(`[Socket] ✅ Playlist saved successfully: ${payload.id}`);

        // 2. Respond to client immediately
        if (typeof ack === "function") ack({ ok: true });
        io.emit("playlists:updated");

        // 3. Download missing songs in background
        console.log(
          `[Socket] 📥 Starting automatic download for missing songs...`,
        );

        // Transform tracks to download format (match scheduler format)
        const downloadList = payload.tracks
          .filter((track) => track.sourceFileName) // Only tracks with source file
          .map((track) => ({
            fileName: track.sourceFileName, // Source filename from API
            filename_as: track.filename, // Target filename on disk
            title: track.title,
            artist: track.artist,
          }));

        if (downloadList.length > 0) {
          console.log(
            `[Socket] 📦 Prepared ${downloadList.length} tracks for download check`,
          );
          try {
            await downloadMissingSongs(downloadList);
            console.log(
              `[Socket] ✅ Download check completed for ${payload.id}`,
            );
          } catch (error) {
            console.error(`[Socket] ❌ Error during download:`, error);
            // Don't fail the save operation if download fails
          }
        } else {
          console.log(`[Socket] ⚠️ No source filenames available for download`);
        }

        // Refresh media library cache so new files/metadata appear without restarting
        try {
          const refreshedLibrary = await refreshLibrary();
          io.emit("library:update", refreshedLibrary);
        } catch (e) {
          console.error("[Socket] ⚠️ Failed to refresh library after save:", e);
        }
      } else {
        console.error(`[Socket] ❌ Failed to save playlist: ${result.error}`);
        if (typeof ack === "function") ack({ ok: false, error: result.error });
      }
    });

    // 3. SWITCHING
    socket.on("radio:switch_playlist", (payload, ack) => {
      if (!payload || !payload.id) {
        if (typeof ack === "function") ack({ ok: false, error: "Missing ID" });
        return;
      }

      const result = switchPlaylist(payload.id);
      if (typeof ack === "function") {
        ack(
          result.success
            ? {
                ok: true,
                pending: !!result.pending,
                pendingPlaylistId: result.pendingPlaylistId || null,
              }
            : { ok: false, error: result.error },
        );
      }
      broadcastState();
    });

    socket.on("radio:queue_switch", (payload, ack) => {
      if (!payload || !payload.id) {
        if (typeof ack === "function") ack({ ok: false, error: "Missing ID" });
        return;
      }
      const result = queuePlaylistSwitch(payload.id);
      if (typeof ack === "function") {
        ack(
          result.success
            ? {
                ok: true,
                pending: !!result.pending,
                pendingPlaylistId: result.pendingPlaylistId || null,
              }
            : { ok: false, error: result.error },
        );
      }
      broadcastState();
    });

    socket.on("radio:cancel_pending", (ack) => {
      const result = cancelPendingPlaylist();
      if (typeof ack === "function") ack(result);
      broadcastState();
    });

    socket.on("radio:apply_pending", (ack) => {
      const result = applyPendingPlaylistNow();
      if (typeof ack === "function") ack(result);
      broadcastState();
    });

    socket.on("crossfade_set", (payload, ack) => {
      const patch = payload || {};
      const res = setCrossfadeConfig(patch);
      broadcastState();
      io.emit("crossfade:graphical:state", state.crossfadeGraphical);
      if (typeof ack === "function") ack(res);
    });

    socket.on("crossfade_enable", (enabled, ack) => {
      const res = enableCrossfade(enabled);
      broadcastState();
      io.emit("crossfade:graphical:state", state.crossfadeGraphical);
      if (typeof ack === "function") ack(res);
    });

    socket.on("crossfade_preset", (payload, ack) => {
      const name =
        typeof payload === "string" ? payload : payload?.name || payload;
      const res = applyCrossfadePreset(name);
      broadcastState();
      io.emit("crossfade:graphical:state", state.crossfadeGraphical);
      if (typeof ack === "function") ack(res);
    });

    socket.on("crossfade:graphical:get", (_payload, ack) => {
      if (typeof ack === "function") {
        ack({ ok: true, state: state.crossfadeGraphical });
      }
    });

    socket.on("crossfade:graphical:update", (payload, ack) => {
      const {
        fadeInMs,
        fadeOutMs,
        preloadMs,
        overlapMs,
        enabled: graphicalEnabled,
        preset: graphicalPreset,
      } = payload || {};

      state.crossfadeGraphical = {
        ...state.crossfadeGraphical,
        ...(payload || {}),
      };

      // Map graphical timing/preset/enabled to mixer crossfade config
      const timingPatch = {};
      if (fadeInMs !== undefined) timingPatch.fadeInMs = fadeInMs;
      if (fadeOutMs !== undefined) timingPatch.fadeOutMs = fadeOutMs;
      if (preloadMs !== undefined) timingPatch.preloadMs = preloadMs;
      if (overlapMs !== undefined) timingPatch.overlapMs = overlapMs;
      if (Object.keys(timingPatch).length > 0) setCrossfadeConfig(timingPatch);
      if (graphicalEnabled !== undefined) enableCrossfade(graphicalEnabled);
      if (graphicalPreset) applyCrossfadePreset(graphicalPreset);

      io.emit("crossfade:graphical:state", state.crossfadeGraphical);
      broadcastState();
      if (typeof ack === "function") {
        ack({ ok: true, state: state.crossfadeGraphical });
      }
    });

    // ===========================
    //       LEGACY / CONTROL
    // ===========================

    socket.on("hard_stop", (arg1, arg2) => {
      stopPlayback(true);
      broadcastState();
      safeAck(arg1, arg2, { ok: true, stopped: "forced" });
    });

    socket.on("get_playlist", () => {
      socket.emit("playlist_update", state.playlist || []);
    });

    socket.on("player:play", (payload, ack) => {
      if (!payload || !payload.uuid) {
        if (typeof ack === "function")
          ack({ ok: false, error: "Missing UUID" });
        return;
      }
      try {
        const result = playTrackById(payload.uuid);
        if (typeof ack === "function")
          ack(
            result.success ? { ok: true } : { ok: false, error: result.error },
          );
      } catch (e) {
        console.error("[Socket] Play Error:", e);
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("get_station_info", () => {
      socket.emit("radio_channel_info", state.stationInfo || {});
    });

    socket.on("start", (arg1, arg2) => {
      const wasStopped = state.isPaused || state.stopRequested;
      state.isPaused = false;
      state.stopRequested = false;

      if (wasStopped) {
        restartRadio();
      }
      broadcastState();
      safeAck(arg1, arg2, { ok: true, started: true });
    });

    socket.on("stop", (arg1, arg2) => {
      stopAfterCurrent();
      broadcastState();
      safeAck(arg1, arg2, { ok: true, stopping: "after_current" });
    });

    socket.on("next", (arg1, arg2) => {
      state.isPaused = false;
      nextTrack();
      broadcastState();
      safeAck(arg1, arg2, { ok: true });
    });

    socket.on("restart", (arg1, arg2) => {
      restartCurrentTrack();
      safeAck(arg1, arg2, { ok: true, restarted: true });
    });

    socket.on("get_state", (arg1, arg2) => {
      const activeId = state.activePlaylistId
        ? path.basename(state.activePlaylistId)
        : null;
      safeAck(arg1, arg2, {
        playing: !state.isPaused && !state.stopRequested,
        mode: state.playbackMode === "auto" ? "AUTO" : "MANUAL",
        listeners: state.clients ? state.clients.size : 0,
        nowPlaying: state.currentTrack || null,
        activePlaylistId: activeId,
        pendingPlaylistId: state.pendingPlaylistId
          ? path.basename(state.pendingPlaylistId)
          : null,
        crossfade: state.crossfade,
        isStopping: state.stopRequested,
      });
    });

    socket.on("disconnect", () => {
      console.log("[Socket.IO] 🎛️ Controller disconnected");
    });

    socket.on("req-preview-musicbed", async (data) => {
      // data payload: { items: [ { id: '123', modifiedSettings: { mix_point: 15, cut_in: 2 } }, ... ] }
      if (!data || !Array.isArray(data.items) || data.items.length === 0) {
        socket.emit("error", { message: "Invalid music bed payload" });
        return;
      }

      try {
        console.log("Generating Music Bed Preview...");

        const outputPath = path.join(
          CONFIG.TEMP_DIR,
          `preview_bed_${socket.id}_${Date.now()}.mp3`,
        );

        await buildRealMusicBed(data.items, outputPath, {
          limitSeconds: data.limitSeconds || 120,
        });

        socket.emit("preview-musicbed-ready", {
          url: `/stream/temp/${path.basename(outputPath)}`,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("Music Bed Error:", err);
        socket.emit("error", {
          message: "Failed to render music bed: " + err.message,
        });
      }
    });
  });

  return io;
};
