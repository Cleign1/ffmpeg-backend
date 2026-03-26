// --- CENTRAL CONFIGURATION ---
// Format: "YYYY-MM-DDTHH:mm:ss"
// Set to "" (empty string) to run in LIVE MODE.
const START_TIME_ANCHOR = "2026-03-21T18:00:00";
// const START_TIME_ANCHOR = "";

// Used a function to calculate this immediately to ensure 'state' gets the correct value.
const calculateInitialOffset = () => {
  if (!START_TIME_ANCHOR || START_TIME_ANCHOR.trim() === "") {
    console.log(`[System] 📡 Starting in LIVE BROADCAST mode.`);
    return 0;
  }

  const target = new Date(START_TIME_ANCHOR).getTime();
  const now = Date.now();

  if (isNaN(target)) {
    console.error(
      `[System] ❌ CRITICAL CONFIG ERROR: START_TIME_ANCHOR is invalid ("${START_TIME_ANCHOR}"). Falling back to LIVE mode.`,
    );
    return 0;
  }

  const offset = target - now;
  console.log(`[System] 🕒 TIME TRAVEL ACTIVE. Anchor: ${START_TIME_ANCHOR}`);
  console.log(`[System]    Target TS: ${target}`);
  console.log(`[System]    Current TS: ${now}`);
  console.log(`[System]    Offset: ${offset} ms`);
  return offset;
};

// Execute calculation
const initialOffset = calculateInitialOffset();
const isManual = initialOffset !== 0;

export const state = {
  playlist: [],
  timeOffset: initialOffset,
  manualPlaylist: [], // ✅ MUST EXIST
  playbackMode: "auto", // 'auto' | 'manual'
  isPaused: true, // start paused
  allowAutoStart: true, // do not autoplay
  isBroadcasting: false,
  stopAfterCurrent: false,
  stopRequested: false,

  currentTrack: null,
  radioStartTime: 0,
  playlistVersion: Date.now(),

  // Multi-playlist / Editing Support
  shadowPlaylists: {},
  pendingPlaylistId: null,

  // settings for crossfade
  crossfade: {
    enabled: true,
    preloadMs: 3100,
    overlapMs: -1200,
    fadeOutMs: 2800,
    fadeInMs: 700,
  },
  crossfadeGraphical: {
    preset: "normal",
    enabled: true,
    playheadSeconds: 0,
    lockBufferSeconds: 5,
    layers: [],
  },
  clients: new Set(),

  downloadStats: {
    totalSongs: 0,
    totalBytes: 0,
    lastSpeed: 0,
    lastLatency: 0,
    activeDownloads: 0,
    errors: 0,
  },
};

export const getRadioTime = () => {
  // Always calculate fresh based on the current state offset
  if (isNaN(state.timeOffset)) return new Date();
  return new Date(Date.now() + state.timeOffset);
};
