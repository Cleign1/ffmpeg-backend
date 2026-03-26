import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { normalizeCategory } from "../services/library.js";

export const listVoiceTracks = () => {
  const files = fs.readdirSync(CONFIG.SONGS_DIR);
  const voice = [];
  files.forEach((f) => {
    const cat = normalizeCategory("", f);
    if (cat === "Voice Track" || f.toLowerCase().includes("cat_vt_ai")) {
      voice.push(f);
    }
  });
  return voice;
};
