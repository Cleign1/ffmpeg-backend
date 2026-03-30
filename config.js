import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: ".env.local" });

function resolveDir(envVarName, fallbackRelativePath) {
  const configuredPath = process.env[envVarName];
  if (configuredPath && configuredPath.trim()) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(__dirname, configuredPath);
  }

  return path.join(__dirname, fallbackRelativePath);
}

const SONGS_DIR = resolveDir("SONGS_DIR", "songs");
const DATA_DIR = resolveDir("DATA_DIR", "song_data");
const TEMP_DIR = resolveDir("TEMP_DIR", "temp");

[SONGS_DIR, DATA_DIR, TEMP_DIR].forEach((dirPath) => {
  mkdirSync(dirPath, { recursive: true });
});

export const CONFIG = {
  PORT: process.env.PORT || 3000,
  SONGS_DIR,
  DATA_DIR,
  TEMP_DIR,
  CLIENT_DIST: path.join(__dirname, "client", "dist"),
  PLAYLIST_URL: process.env.API_PLAYLIST_URL || "",
  AUDIO_API_BASE: process.env.API_DOWNLOAD_URL || "",
  RADIO_CHANNEL_ID: process.env.RADIO_CHANNEL_ID || "",
  RADIO_PINE: process.env.PINE || "",
  RADIO_NETWORK_ID: process.env.NETWORK_ID || "",
  RADIO_NETWORK_CODE: process.env.NETWORK_CODE || "",
  RADIO_LOCAL_ID: process.env.LOCAL_ID || "",
  TIME_ZONE: process.env.TIME_ZONE || "Asia/Jakarta",
  EDITOR_UPLOAD_TOKEN: process.env.EDITOR_UPLOAD_TOKEN || "",
  SOCKET_AUTH_TOKEN: process.env.SOCKET_AUTH_TOKEN || "",
};
