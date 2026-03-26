import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: ".env.local" });

export const CONFIG = {
  PORT: process.env.PORT || 3000,
  SONGS_DIR: path.join(__dirname, "songs"),
  DATA_DIR: path.join(__dirname, "song_data"),
  TEMP_DIR: path.join(__dirname, "temp"),
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
