import express from "express";
import cors from "cors";
import http from "http";

import { CONFIG } from "./config.js";
import { runSmartSync } from "./services/scheduler.js";
import { loadPlaylist } from "./services/playlist.js";
import { startRadio } from "./services/radio.js";
import { startControlSocket } from "./services/controlSocket.js";
import { setIoInstance } from "./services/socketHub.js";

import playlistRoutes from "./routes/playlist.js";
import streamRoutes from "./routes/stream.js";
import statusRoutes from "./routes/status.js";
import previewRoutes from "./routes/preview.js";
import editorRoutes from "./routes/editor.js";

const app = express();
app.use(cors());

app.use("/api", playlistRoutes);
app.use("/api", streamRoutes);
app.use("/api", statusRoutes);
app.use("/api", previewRoutes);
app.use("/api", editorRoutes);
app.use("/stream/temp", express.static(CONFIG.TEMP_DIR));

const server = http.createServer(app);

// Start socket.io
const io = startControlSocket(server);
setIoInstance(io);

server.listen(CONFIG.PORT, "0.0.0.0", async () => {
  console.log(`🎙️ Radio Server running at http://127.0.0.1:${CONFIG.PORT}`);

  await runSmartSync();
  loadPlaylist();
  startRadio();

  setInterval(runSmartSync, 10 * 60 * 1000);
});
