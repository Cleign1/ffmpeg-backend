import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { state, getRadioTime } from "../store.js";
import crypto from "crypto";
import { getZonedDateParts } from "../utils/time.js";

// --- HELPER: Find the JSON file for a specific time ---
const getJsonPathForTime = (targetTime) => {
  try {
    if (!fs.existsSync(CONFIG.DATA_DIR)) return null;

    const { dateStr, hourStr } = getZonedDateParts(
      targetTime,
      CONFIG.TIME_ZONE,
    );
    const currentHour = hourStr;

    const files = fs
      .readdirSync(CONFIG.DATA_DIR)
      .filter((f) => {
        // Support both standard and edited files
        return (
          f.startsWith(`playlist_${currentHour}_`) &&
          f.endsWith(".json") &&
          f.includes(dateStr)
        );
      })
      .map((f) => ({
        name: f,
        time: fs.statSync(path.join(CONFIG.DATA_DIR, f)).mtime.getTime(),
        isEdited: f.includes("edited-sanoma-playlist"),
      }))
      .sort((a, b) => {
        // Priority 1: Edited files come first
        if (a.isEdited && !b.isEdited) return -1;
        if (!a.isEdited && b.isEdited) return 1;
        // Priority 2: Newer files come first
        return b.time - a.time;
      });

    return files.length > 0 ? path.join(CONFIG.DATA_DIR, files[0].name) : null;
  } catch (e) {
    return null;
  }
};

// --- HELPER: Parse a JSON file into Track Objects ---
const parseJsonToTracks = (jsonPath) => {
  try {
    const rawData = fs.readFileSync(jsonPath, "utf-8");
    let parsed = JSON.parse(rawData);

    // 1. Unwrapping Logic (Handle arrays wrapping the object)
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (parsed[0].details || parsed[0].playlist || parsed[0].customer)
        parsed = parsed[0];
    }

    // 2. Handle "Root Key" wrapping (if the JSON has a single dynamic root key)
    const keys = Object.keys(parsed);
    if (keys.length === 1 && !isNaN(parseInt(keys[0])))
      parsed = parsed[keys[0]];

    // --- 🟢 NEW: Extract Customer Info ---
    if (parsed.customer) {
      // We save this to the global state immediately
      state.stationInfo = {
        network_code: parsed.customer.network_code,
        network_id: parsed.customer.network_id,
        local_code: parsed.customer.local_code,
        country_code: parsed.customer.country_code,
      };
    }
    // -------------------------------------

    if (parsed.message) {
      console.warn(
        `[System] ⚠️ Playlist file contains message: "${parsed.message}"`,
      );
      return [];
    }

    // 3. Extract Tracks (Existing Logic)
    let detailsRaw = null;
    if (parsed.playlist && parsed.playlist.details)
      detailsRaw = parsed.playlist.details;
    else if (parsed.details) detailsRaw = parsed.details;
    else if (Array.isArray(parsed)) detailsRaw = parsed;

    if (!detailsRaw) return [];

    let detailsArray = Array.isArray(detailsRaw)
      ? detailsRaw
      : Object.values(detailsRaw);

    return detailsArray.map((item, index) => {
      const sourceId = item.fileName;
      const sourceExt = path.extname(sourceId || "") || ".mp3";

      // Build multiple filename candidates to match the downloader's naming scheme
      const candidates = [];

      // 1) Deterministic audio_id + ext (used by scheduler downloads)
      if (item.audio_id) candidates.push(`${item.audio_id}${sourceExt}`);

      // 2) Server-provided filename_as
      if (item.filename_as) candidates.push(item.filename_as);

      // 3) Original sourceId stripped of prefixes
      if (sourceId) {
        candidates.push(
          sourceId
            .replace("AWE--", "")
            .replace("IDO--", "")
            .replace("HEL--", ""),
        );
      }

      // 4) Human-friendly Title - Artist.ext (used by manual playlists)
      if (item.artist && item.title && sourceId) {
        const safeArtist = item.artist.replace(/[<>:"/\\|?*]/g, "").trim();
        const safeTitle = item.title.replace(/[<>:"/\\|?*]/g, "").trim();
        if (safeArtist && safeTitle) {
          candidates.push(`${safeTitle} - ${safeArtist}${sourceExt}`);
        }
      }

      // 5) Fallback placeholder
      candidates.push(`track_${index}${sourceExt}`);

      // Sanitize and pick the first candidate that exists on disk; otherwise first candidate
      let filename = candidates.find((name) => {
        const safe = name.replace(/[<>:"/\\|?*]/g, "");
        return fs.existsSync(path.join(CONFIG.SONGS_DIR, safe));
      });
      if (!filename) filename = candidates[0];
      if (filename) filename = filename.replace(/[<>:"/\\|?*]/g, "");

      const fullPath = path.join(CONFIG.SONGS_DIR, filename);
      const exists = fs.existsSync(fullPath);

      const cutIn = parseInt(item.cutIn || 0);
      const cutOut = parseInt(item.cutOut || 10000000);
      let mixPoint = parseInt(item.mix_point_pr_ev || 0);
      if (mixPoint === 0 || mixPoint > cutOut) mixPoint = cutOut;
      const playDurationMs = cutOut - cutIn;

      return {
        title: item.title || "Unknown Title",
        artist: item.artist || "Unknown Artist",
        category: item.bc_category || "Music",
        filename: filename,
        fileExists: exists,
        path: fullPath,
        cutInMs: cutIn,
        cutOutMs: cutOut,
        mixPointMs: mixPoint,
        playDurationMs: playDurationMs > 0 ? playDurationMs : 0,
        duration: Math.ceil(playDurationMs / 1000),
        type: "music",
        uuid: item.uuid || crypto.randomUUID(), // Read from file or generate
        _raw: item, // Preserve raw data for save
      };
    });
  } catch (e) {
    console.error("Error parsing playlist:", e);
    return [];
  }
};

// --- MAIN: Load Playlist (Initial) ---
export const loadPlaylist = (specificPath = null) => {
  const now = getRadioTime();

  // Allow forcing a specific file (e.g. after edit)
  const jsonPath = specificPath || getJsonPathForTime(now);

  if (!jsonPath) {
    console.warn(
      `[System] ⚠️ No playlist found for ${now.toLocaleTimeString()}`,
    );
    return false;
  }

  const tracks = parseJsonToTracks(jsonPath);
  if (tracks.length === 0) return false;

  // Add IDs based on current state length
  state.playlist = tracks.map((t, i) => ({
    ...t,
    id: i,
    uuid: t.uuid || crypto.randomUUID(),
  }));

  recalculateOffsets();
  state.activePlaylistId = jsonPath;
  state.pendingPlaylistId = null;
  if (state._broadcastState) state._broadcastState();

  // --- 🟢 NEW: Broadcast Station Info ---
  // Now that parsing is done, stationInfo is in the state. Send it to clients.
  if (state._broadcastStationInfo) {
    state._broadcastStationInfo();
  }
  // --------------------------------------

  console.log(
    `[System] ✅ Loaded Playlist: ${path.basename(jsonPath)} (${state.playlist.length} songs).`,
  );
  return true;
};

// --- NEW: Save Edited Playlist ---
export const saveEditedPlaylist = (tracks, targetTime) => {
  try {
    const jsonPath = getJsonPathForTime(targetTime);
    if (!jsonPath)
      return { success: false, error: "No base playlist found to edit." };

    const rawData = fs.readFileSync(jsonPath, "utf-8");
    let parsed = JSON.parse(rawData);
    let root = parsed;

    // Unwrapping logic (same as parse) to find the root object containing 'details')
    if (Array.isArray(parsed) && parsed.length > 0) {
      root = parsed[0];
    }
    // Simplified structure assumption based on read file

    // Map updated tracks back to 'details' structure
    const newDetails = tracks.map((t) => {
      // Use _raw if available, or create minimal structure
      const base = t._raw || {};
      return {
        ...base,
        title: t.title,
        artist: t.artist,
        filename_as: t.filename,
        cutIn: t.cutInMs,
        cutOut: t.cutOutMs,
        mix_point_pr_ev: t.mixPointMs,
        uuid: t.uuid, // IMPORTANT: Persist UUID
      };
    });

    // Update the structure
    if (root.playlist && root.playlist.details)
      root.playlist.details = newDetails;
    else if (root.details) root.details = newDetails;

    // Construct New Filename
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath, ".json");
    let newName = base;
    if (!base.includes("edited-sanoma-playlist")) {
      newName = `${base}_edited-sanoma-playlist`;
    }
    const newPath = path.join(dir, `${newName}.json`);

    // Wrap in array if original was array
    const output = Array.isArray(parsed) ? [root] : root;

    fs.writeFileSync(newPath, JSON.stringify(output, null, 2));
    console.log(`[System] 💾 Saved edited playlist to: ${newPath}`);
    return { success: true, path: newPath };
  } catch (e) {
    console.error("Error saving playlist:", e);
    return { success: false, error: e.message };
  }
};

// --- MANAGE MANUAL PLAYLISTS ---

export const listPlaylists = () => {
  try {
    if (!fs.existsSync(CONFIG.DATA_DIR)) return [];

    return fs
      .readdirSync(CONFIG.DATA_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const fullPath = path.join(CONFIG.DATA_DIR, f);
        const stats = fs.statSync(fullPath);
        // Determine type based on filename convention
        // Scheduler: playlist_HH_YYYY-MM-DD...
        // Manual: manual_...
        let type = "unknown";
        if (f.startsWith("manual_")) type = "manual";
        else if (f.startsWith("playlist_")) type = "scheduler";
        else if (f.includes("edited-sanoma-playlist")) type = "manual_copy";

        return {
          id: f, // Filename is the ID
          name: f
            .replace(".json", "")
            .replace("manual_", "")
            .replace("playlist_", ""),
          type: type,
          modified: stats.mtime,
        };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch (e) {
    console.error("[Playlist] Error listing playlists:", e);
    return [];
  }
};

export const createManualPlaylist = (name, sourceTracks = []) => {
  try {
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "");
    const filename = `manual_${safeName}.json`;
    const filePath = path.join(CONFIG.DATA_DIR, filename);

    if (fs.existsSync(filePath)) {
      return { success: false, error: "Playlist already exists" };
    }

    // Structure matches the standard format
    const playlistData = {
      playlist: {
        details: sourceTracks.map((t) => ({
          ...t,
          // Ensure we save clean data
          uuid: crypto.randomUUID(),
          cutIn: t.cutInMs,
          cutOut: t.cutOutMs,
          mix_point_pr_ev: t.mixPointMs,
          filename_as: t.filename,
        })),
      },
    };

    fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
    return { success: true, id: filename };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

export const saveManualPlaylist = (id, tracks) => {
  try {
    const filePath = path.join(CONFIG.DATA_DIR, id);

    // Security check: ensure we are writing to a JSON in data dir
    if (!filePath.startsWith(CONFIG.DATA_DIR) || !id.endsWith(".json")) {
      return { success: false, error: "Invalid playlist ID" };
    }

    const newDetails = tracks.map((t) => ({
      title: t.title,
      artist: t.artist,
      filename_as: t.filename,
      cutIn: t.cutInMs,
      cutOut: t.cutOutMs,
      mix_point_pr_ev: t.mixPointMs,
      uuid: t.uuid,
      bc_category: t.category,
    }));

    const playlistData = {
      playlist: {
        details: newDetails,
      },
    };

    fs.writeFileSync(filePath, JSON.stringify(playlistData, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

export const deletePlaylist = (id) => {
  try {
    const filePath = path.join(CONFIG.DATA_DIR, id);
    if (!filePath.startsWith(CONFIG.DATA_DIR) || !id.endsWith(".json")) {
      return { success: false, error: "Invalid playlist ID" };
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, error: "File not found" };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

// --- NEW: Read Specific Playlist ---
export const readPlaylist = (id) => {
  try {
    const filePath = path.join(CONFIG.DATA_DIR, id);
    if (!filePath.startsWith(CONFIG.DATA_DIR) || !id.endsWith(".json")) {
      return { success: false, error: "Invalid playlist ID" };
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, error: "File not found" };
    }

    const tracks = parseJsonToTracks(filePath);
    return { success: true, tracks };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

export const clonePlaylist = (sourceId, newName) => {
  try {
    const result = readPlaylist(sourceId);
    if (!result.success) return result;

    return createManualPlaylist(newName, result.tracks);
  } catch (e) {
    return { success: false, error: e.message };
  }
};

// --- NEW: Fetch Next Hour Tracks (Dynamic) ---
export const getNextHourTracks = () => {
  const now = getRadioTime();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1);

  console.log(
    `[System] 🔄 Pre-loading next hour: ${nextHour.toLocaleTimeString()}...`,
  );

  const jsonPath = getJsonPathForTime(nextHour);
  if (!jsonPath) {
    console.warn(`[System] ⚠️ Next hour playlist not found yet.`);
    return [];
  }

  return parseJsonToTracks(jsonPath);
};

// --- UTILS: Recalculate Durations ---
export const recalculateOffsets = (targetPlaylist = null) => {
  const list = targetPlaylist || state.playlist;
  let currentOffset = 0;
  list.forEach((track, i) => {
    track.id = i;
    if (!track.uuid) track.uuid = crypto.randomUUID(); // Ensure UUID exists
    track.startTimeMs = currentOffset;
    currentOffset += track.playDurationMs;
  });
  if (!targetPlaylist) {
    state.totalPlaylistDuration = currentOffset / 1000;
  }
  return currentOffset;
};
