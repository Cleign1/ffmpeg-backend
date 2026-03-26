import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. POINT THIS TO THE FILE THAT FAILED
const SONG_FILENAME = "Thomas Dolby - She Blinded Me With Science.wav"; 
const SONG_PATH = path.join(__dirname, 'songs', SONG_FILENAME);

console.log(`\n--- Diagnostic Test: ${SONG_FILENAME} ---`);

if (!fs.existsSync(SONG_PATH)) {
    console.error("❌ File not found at:", SONG_PATH);
    process.exit(1);
}

const stats = fs.statSync(SONG_PATH);
console.log(`File Size: ${(stats.size / 1024).toFixed(2)} KB`);

// 2. PROBE THE FILE
console.log("running ffprobe...");
ffmpeg.ffprobe(SONG_PATH, (err, metadata) => {
    if (err) {
        console.error("❌ FFprobe failed:", err.message);
        return;
    }

    const format = metadata.format;
    console.log("✅ FFprobe Success!");
    console.log(`   Format Name: ${format.format_name}`); // This will tell us if it's really mp3 or wav
    console.log(`   Duration:    ${format.duration} seconds`);
    console.log(`   Bitrate:     ${format.bit_rate}`);

    // 3. TRY A TRANSCODE TEST
    console.log("\nAttempting 5-second conversion test...");
    
    ffmpeg(SONG_PATH)
        .duration(5)
        .toFormat('mp3')
        .save('test-output.mp3')
        .on('error', (err) => {
            console.error("❌ Conversion Failed:", err.message);
        })
        .on('end', () => {
            console.log("✅ Conversion Success! FFmpeg can read this file.");
            console.log("   (Created 'test-output.mp3' for you to check)");
            
            // Clean up
            if(fs.existsSync('test-output.mp3')) fs.unlinkSync('test-output.mp3');
        });
});