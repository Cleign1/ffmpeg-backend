import express from "express";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { randomBytes } from "crypto";
import { CONFIG } from "../config.js";
import { refreshLibrary } from "../services/library.js";
import { emitGlobal } from "../services/socketHub.js";

/**
 * Editor upload routes
 * - Accepts streamed audio from the audio editor (no temp files)
 * - Overwrites existing track when the same ID/filename is provided
 * - Refreshes the media library and notifies connected clients
 *
 * Expected request:
 *   POST /api/editor/upload?filename=<name>&id=<uuid>
 *   Headers (optional):
 *     x-filename: preferred file name (takes priority over query)
 *     x-audio-id: logical track id (used to keep consistent naming)
 *     x-editor-token / Authorization: Bearer <token> (when EDITOR_UPLOAD_TOKEN is set)
 *     content-type: audio/wav | audio/mpeg | audio/mp4 | audio/x-m4a | application/octet-stream
 *
 * If no filename is provided, the server will generate one using the id (or timestamp) and default to .wav
 */
const router = express.Router();

const ALLOWED_MIME_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "application/octet-stream", // allow fallthrough when browser doesn't set type
];

const ALLOWED_EXTENSIONS = [".wav", ".mp3", ".m4a", ".aac", ".webm", ".ogg", ".mp4"];

const MAX_BYTES = 200 * 1024 * 1024; // 200MB guard

function isMimeAllowed(type) {
  if (!type) return true; // allow when browser didn't set it; will rely on extension
  const lower = type.toLowerCase();
  return ALLOWED_MIME_TYPES.some((allowed) => lower.includes(allowed));
}

function isExtensionAllowed(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (!ext) return true; // allow, default was added downstream
  return ALLOWED_EXTENSIONS.includes(ext);
}

function requireEditorAuth(req, res) {
  const token = CONFIG.EDITOR_UPLOAD_TOKEN;
  if (!token) return true; // auth disabled

  const headerToken = req.headers["x-editor-token"] || req.headers["x-editor-auth"];
  const bearer = (req.headers["authorization"] || "").replace(/Bearer\s+/i, "").trim();
  const provided = (headerToken || bearer || "").trim();

  if (!provided || provided !== token) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * Sanitize filename to prevent path traversal and invalid characters.
 */
function sanitizeFilename(name) {
  const base = path.basename(name).replace(/[<>:"/\\|?*]+/g, "");
  return base || `edited-${Date.now()}.wav`;
}

/**
 * Determine the target filename for the uploaded audio.
 */
function resolveTargetFilename({ headerName, queryName, audioId, contentType }) {
  // Priority: explicit header -> query -> derive from id -> fallback timestamp
  let filename = headerName || queryName;

  if (!filename && audioId) {
    // Choose extension based on content type when possible
    const ext =
      contentType && contentType.includes("mpeg")
        ? ".mp3"
        : contentType && contentType.includes("m4a")
          ? ".m4a"
          : ".wav";
    filename = `${audioId}${ext}`;
  }

  if (!filename) {
    filename = `edited-${Date.now()}.wav`;
  }

  return sanitizeFilename(filename);
}

router.post("/editor/upload", async (req, res) => {
  const audioId = req.headers["x-audio-id"] || req.query.id || null;
  const headerFilename = req.headers["x-filename"];
  const queryFilename = req.query.filename;
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  const declaredSize = Number(req.headers["content-length"] || 0);

  if (!requireEditorAuth(req, res)) return;

  // Basic request validation
  if (declaredSize && declaredSize > MAX_BYTES) {
    return res.status(413).json({ ok: false, error: "File too large. Max 200MB." });
  }

  if (!isMimeAllowed(contentType)) {
    return res.status(415).json({ ok: false, error: "Unsupported content-type" });
  }

  const targetFilename = resolveTargetFilename({
    headerName: headerFilename,
    queryName: queryFilename,
    audioId,
    contentType,
  });

  if (!isExtensionAllowed(targetFilename)) {
    return res.status(415).json({ ok: false, error: "Unsupported file extension" });
  }

  const songsDir = CONFIG.SONGS_DIR;
  if (!fs.existsSync(songsDir)) {
    fs.mkdirSync(songsDir, { recursive: true });
  }

  const targetPath = path.join(songsDir, targetFilename);
  const tempPath = path.join(
    songsDir,
    `${targetFilename}.${randomBytes(6).toString("hex")}.uploadtmp`,
  );

  try {
    // Stream directly to a temp file, then atomic rename
    const writeStream = fs.createWriteStream(tempPath);
    await pipeline(req, writeStream);

    const stats = fs.statSync(tempPath);
    if (!stats.size) {
      fs.rmSync(tempPath, { force: true });
      return res.status(400).json({ ok: false, error: "Empty upload" });
    }

    fs.renameSync(tempPath, targetPath);

    // Refresh library cache and notify clients
    const updatedLibrary = await refreshLibrary();
    emitGlobal("library:update", updatedLibrary);

    return res.json({
      ok: true,
      filename: targetFilename,
      id: audioId || null,
      size: fs.statSync(targetPath).size,
      contentType,
      message: "Audio uploaded and library refreshed.",
    });
  } catch (error) {
    console.error("[Editor Upload] Failed to save audio:", error);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (err) {
      // ignore cleanup errors
    }
    return res.status(500).json({
      ok: false,
      error: "Failed to upload audio.",
      details: error.message,
    });
  }
});

export default router;
