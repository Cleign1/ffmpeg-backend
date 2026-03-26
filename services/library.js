import fs from "fs";
import path from "path";
import { parseFile } from "music-metadata";
import { CONFIG } from "../config.js";

let libraryCache = [];
let isScanning = false;

// Allow other modules to clear the in-memory cache when new audio/metadata arrives
export const invalidateLibraryCache = () => {
  libraryCache = [];
};

export const normalizeCategory = (rawCat, filename = "") => {
  const cat = (rawCat || "").toString().trim().toLowerCase();

  // Voice-track patterns (scheduler tags and common variants)
  if (
    cat === "vt" ||
    cat === "voice" ||
    cat === "voicetrack" ||
    cat.startsWith("voice") ||
    cat.includes("cat_vt") ||
    cat.includes("vt_ai") ||
    cat.includes("vt ") ||
    cat.includes(" vt") ||
    cat.includes("vo ") ||
    cat.includes("voice track") ||
    cat.includes("voicetr")
  )
    return "Voice Track";

  if (cat.includes("spot")) return "Spot";
  if (cat.includes("jingle")) return "Jingle";
  if (
    cat.includes("ad") ||
    cat.includes("adv") ||
    cat.includes("commercial") ||
    cat.includes("ads")
  )
    return "Ads";
  if (cat.includes("music") || cat.includes("song") || cat.includes("lagu"))
    return "Music";

  const lowerName = filename.toLowerCase();
  if (
    lowerName.startsWith("vtrack") ||
    lowerName.includes("[vt]") ||
    lowerName.includes(" vt") ||
    lowerName.includes("voice track") ||
    lowerName.includes("voicetr")
  )
    return "Voice Track";
  if (lowerName.includes("spot")) return "Spot";
  if (lowerName.includes("jingle")) return "Jingle";
  if (
    lowerName.includes("ad") ||
    lowerName.includes("adv") ||
    lowerName.includes("commercial")
  )
    return "Ads";
  return "Music";
};

// --- NEW: Helper to build metadata map from daily schedules ---
const buildMetadataMap = () => {
  const map = new Map();
  try {
    if (!fs.existsSync(CONFIG.DATA_DIR)) return map;
    const files = fs
      .readdirSync(CONFIG.DATA_DIR)
      .filter((f) => f.startsWith("playlist_") && f.endsWith(".json"));

    files.forEach((f) => {
      try {
        const raw = fs.readFileSync(path.join(CONFIG.DATA_DIR, f), "utf-8");
        let root = JSON.parse(raw);
        if (Array.isArray(root)) root = root[0];
        const keys = Object.keys(root);
        if (keys.length === 1 && !isNaN(parseInt(keys[0])))
          root = root[keys[0]];

        let details = root.playlist?.details || root.details;
        if (!details) return;

        const items = Array.isArray(details) ? details : Object.values(details);
        items.forEach((item) => {
          // Reconstruct filename to match what's on disk (Same logic as scheduler.js)
          let filename = item.filename_as;
          const sourceId = item.fileName || item.preview_filename;

          if (item.artist && item.title && sourceId) {
            const ext = path.extname(sourceId) || ".mp3";
            const safeArtist = item.artist.replace(/[<>:"/\\|?*]/g, "").trim();
            const safeTitle = item.title.replace(/[<>:"/\\|?*]/g, "").trim();
            if (safeArtist && safeTitle) {
              filename = `${safeTitle} - ${safeArtist}${ext}`;
            }
          }

          if (!filename) {
            if (item.filename) filename = item.filename;
            else if (sourceId)
              filename = sourceId
                .replace("AWE--", "")
                .replace("IDO--", "")
                .replace("HEL--", "");
          }

          if (filename) {
            filename = filename.replace(/[<>:"/\\|?*]/g, "");
            map.set(filename, {
              category: normalizeCategory(
                item.bc_category || item.category,
                filename,
              ),
              title: item.title,
              artist: item.artist,
              cutIn: parseInt(item.cutIn || 0),
              cutOut: parseInt(item.cutOut || 0),
              mixPoint: parseInt(item.mix_point_pr_ev || 0),
            });
          }
        });
      } catch (e) {}
    });
  } catch (e) {
    console.error("[Library] Metadata build failed", e);
  }
  return map;
};
// -------------------------------------------------------------

const parseFilename = (filename) => {
  const name = filename.substring(0, filename.lastIndexOf("."));
  const parts = name.split(" - ");
  if (parts.length === 2) {
    return { title: parts[0].trim(), artist: parts[1].trim() };
  }
  if (parts.length > 2) {
    const artist = parts.pop();
    const title = parts.join(" - ");
    return { title: title.trim(), artist: artist.trim() };
  }
  return { title: name, artist: "Unknown" };
};

const categorizeFile = (filename) => {
  return normalizeCategory(null, filename);
};

export const scanLibrary = async () => {
  if (isScanning) return libraryCache;
  isScanning = true;
  console.log("[Library] 🔍 Scanning songs...");

  try {
    if (!fs.existsSync(CONFIG.SONGS_DIR)) {
      libraryCache = [];
      return [];
    }

    // 1. Build Metadata Map from Schedules
    const metadataMap = buildMetadataMap();
    console.log(
      `[Library] 🗺️ Loaded metadata for ${metadataMap.size} known tracks.`,
    );

    const files = fs.readdirSync(CONFIG.SONGS_DIR);
    const validFiles = files.filter(
      (f) =>
        !f.startsWith(".") &&
        (f.endsWith(".mp3") || f.endsWith(".wav") || f.endsWith(".m4a")),
    );

    const results = await Promise.all(
      validFiles.map(async (f) => {
        const fullPath = path.join(CONFIG.SONGS_DIR, f);
        const jsonPath = path.join(CONFIG.DATA_DIR, `${f}.json`);
        const metadataPath = path.join(
          CONFIG.DATA_DIR,
          "metadata",
          `${path.basename(f, path.extname(f))}.json`,
        );
        const sidecarPath = fs.existsSync(metadataPath)
          ? metadataPath
          : jsonPath;

        // Priority 1: Schedule Metadata (Fixes Issue 2)
        if (metadataMap.has(f)) {
          const meta = metadataMap.get(f);
          const playDur = meta.cutOut - meta.cutIn;
          return {
            filename: f,
            title: meta.title,
            artist: meta.artist,
            category: meta.category,
            duration: Math.ceil(playDur / 1000),
            playDurationMs: playDur,
            cutInMs: meta.cutIn,
            cutOutMs: meta.cutOut,
            mixPointMs: meta.mixPoint,
          };
        }

        // Priority 2: Cache/JSON Sidecar (including DATA_DIR/metadata/<basename>.json)
        if (fs.existsSync(sidecarPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
            return {
              filename: f,
              title:
                data.format?.tags?.title ||
                data.title ||
                parseFilename(f).title,
              artist:
                data.format?.tags?.artist ||
                data.artist ||
                parseFilename(f).artist,
              category: data.category
                ? normalizeCategory(data.category, f)
                : categorizeFile(f),
              duration: data.format?.duration || 0,
              playDurationMs: (data.format?.duration || 0) * 1000,
              cutInMs: data.markers?.cut_in || 0,
              cutOutMs:
                data.markers?.cut_out || (data.format?.duration || 0) * 1000,
              mixPointMs: data.markers?.mix_point_end || 0,
            };
          } catch (e) {}
        }

        // Priority 3: Parse File
        try {
          const metadata = await parseFile(fullPath);
          const { title, artist } = parseFilename(f);
          const finalTitle = metadata.common.title || title;
          const finalArtist = metadata.common.artist || artist;
          const duration = metadata.format.duration || 0;

          return {
            filename: f,
            title: finalTitle,
            artist: finalArtist,
            category: categorizeFile(f),
            duration: duration,
            playDurationMs: duration * 1000,
            cutInMs: 0,
            cutOutMs: duration * 1000,
            mixPointMs: Math.max(0, duration * 1000 - 3000),
          };
        } catch (e) {
          console.error(`[Library] Error parsing ${f}:`, e.message);
          const { title, artist } = parseFilename(f);
          return {
            filename: f,
            title: title,
            artist: artist,
            category: categorizeFile(f),
            duration: 0,
            playDurationMs: 0,
            cutInMs: 0,
            cutOutMs: 0,
            mixPointMs: 0,
          };
        }
      }),
    );

    libraryCache = results.filter((r) => r !== null);
    console.log(`[Library] ✅ Scanned ${libraryCache.length} songs.`);
  } catch (e) {
    console.error("[Library] Scan failed:", e);
  } finally {
    isScanning = false;
  }

  return libraryCache;
};

export const getLibrary = async () => {
  if (libraryCache.length === 0) return await scanLibrary();
  return libraryCache;
};

// Convenience helper to invalidate cache and rescan in one call
export const refreshLibrary = async () => {
  invalidateLibraryCache();
  return await scanLibrary();
};
