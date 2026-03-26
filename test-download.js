// test-download.js
import { downloadSong } from './utils/downloadSong.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 1. Load Environment Variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: '.env.local' });

const runTest = async () => {
    console.log("\n--- Starting Downloader Test ---");

    // 2. Define Test Data
    // Use a REAL fileName from your JSON logs to ensure the API accepts it.
    // Based on your previous logs, "IDO--3--Oceans.Spit.m4a" seemed to be valid.
    const TEST_SOURCE_ID = "VTrack-AI_2026-01-10_18_00_1767845751840.mp3";
    const TEST_TARGET_NAME = "SAN--HEL--VTrack-AI_2026-01-10_18_00_1767845751840.m4a";

    console.log(`Testing download:`);
    console.log(`   Source (fileName):   ${TEST_SOURCE_ID}`);
    console.log(`   Target (filename_as): ${TEST_TARGET_NAME}`);

    try {
        // 3. Run the function
        const success = await downloadSong(TEST_TARGET_NAME, TEST_SOURCE_ID);

        if (success) {
            console.log("\n✅ Test Passed! File downloaded.");
            console.log(`Check your 'songs' folder for '${TEST_TARGET_NAME}'.`);
        } else {
            console.log("\n❌ Test Failed. Function returned false.");
        }

    } catch (error) {
        console.error("\n❌ Test Crashed:", error);
    }
};

runTest();