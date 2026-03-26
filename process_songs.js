import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeAudio } from './utils/audioAnalyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SONGS_DIR = path.join(__dirname, 'songs');
const DATA_DIR = path.join(__dirname, 'song_data');

// 1. Ensure Output Directory Exists
if (!fs.existsSync(DATA_DIR)) {
    console.log(`[SETUP] Creating folder: ${DATA_DIR}`);
    fs.mkdirSync(DATA_DIR);
}

// 2. Main Processing Function
async function processLibrary() {
    console.log("==========================================");
    console.log("   STARTING AUDIO ANALYSIS WORKFLOW");
    console.log("==========================================\n");

    // Get all MP3/M4A files
    const files = fs.readdirSync(SONGS_DIR)
        .filter(file => file.endsWith('.mp3') || file.endsWith('.m4a'));

    if (files.length === 0) {
        console.log("[WARN] No songs found in 'songs' folder.");
        return;
    }

    console.log(`[INFO] Found ${files.length} songs to check.`);

    for (const [index, file] of files.entries()) {
        const inputPath = path.join(SONGS_DIR, file);
        
        // Output Filename: song.mp3.json
        const jsonFilename = `${file}.json`;
        const outputPath = path.join(DATA_DIR, jsonFilename);

        // Check if we already processed this file to save time
        if (fs.existsSync(outputPath)) {
            console.log(`[SKIP] ${index + 1}/${files.length}: ${file} (Already processed)`);
            continue;
        }

        console.log(`[BUSY] ${index + 1}/${files.length}: Analyzing ${file}...`);
        
        try {
            // Run the heavy analysis
            const result = await analyzeAudio(inputPath, file);

            if (result.status) {
                // Save the successful JSON
                fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
                console.log(`   └─ [OK] Markers found: CutIn:${result.markers.cut_in}ms / Mix:${result.markers.mix_point_end}ms`);
            } else {
                console.error(`   └─ [FAIL] ${result.message}`);
            }
        } catch (err) {
            console.error(`   └─ [ERR] Processing failed: ${err.message}`);
        }
    }

    console.log("\n==========================================");
    console.log("   WORKFLOW COMPLETE");
    console.log("==========================================");
}

// Run the script
processLibrary();