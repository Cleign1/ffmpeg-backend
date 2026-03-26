// test-fetch.js
import { fetchPlaylist } from './utils/fetchPlaylist.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 1. Setup paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2. Load Environment Variables
const envPath = path.join(__dirname, '.env.local');
dotenv.config({ path: envPath });

const runTest = async () => {
    console.log("\n--- Starting Fetch & Save Test ---");

    const API_URL = process.env.API_PLAYLIST_URL; 
    
    if (!API_URL) {
        console.error("❌ CRITICAL ERROR: process.env.API_PLAYLIST_URL is undefined.");
        return;
    }

    // Dynamic Date & Time
    const now = new Date();
    // const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const dateStr = '2026-01-10'
    // const hourStr = String(now.getHours()).padStart(2, '0'); // HH
    const hourStr = '18'

    try {
        // 3. Fetch Data
        const data = await fetchPlaylist(API_URL, dateStr, hourStr);
        
        // 4. Define Filename (e.g., playlist-2025-01-07-14.json)
        const filename = `playlist-${dateStr}-${hourStr}-test.json`;
        const filePath = path.join(__dirname, filename);

        // 5. Save to Root Folder
        console.log(`\n[System] Saving data to: ${filename}...`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        
        console.log(`✅ Success! File saved at:\n   ${filePath}`);

    } catch (error) {
        console.log("\n❌ Test Failed:");
        console.error(error.message);
    }
};

runTest();