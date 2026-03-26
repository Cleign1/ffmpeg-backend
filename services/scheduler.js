import { syncMetadata } from './metadata.js';
import { downloadMissingSongs } from '../utils/downloadSong.js';
import { getRadioTime, state } from '../store.js';
import path from 'path';

/**
 * Helper: Formats bytes into human-readable MB/GB
 */
const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0.00 MB';
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(2)} MB`;
};

/**
 * Helper: Generates a readable time summary (e.g. "2m 14s")
 */
const getTimeString = (startTime) => {
    const durationMs = Date.now() - startTime;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = ((durationMs % 60000) / 1000).toFixed(0);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

/**
 * Helper: Converts Raw API JSON into a list format the Downloader understands.
 * EXPORTED for use in controlSocket.js future playlist generation
 */
export const extractSongsFromData = (apiData) => {
    let detailsRaw = null;

    // Unwrap Array
    if (Array.isArray(apiData) && apiData.length > 0) {
        if (apiData[0].details || apiData[0].version || apiData[0].playlist) {
            apiData = apiData[0];
        }
    }

    // Unwrap Dynamic Hour Key
    const keys = Object.keys(apiData);
    if (keys.length === 1 && !isNaN(parseInt(keys[0]))) {
        apiData = apiData[keys[0]];
    }

    // Check for "message" (Empty Playlist)
    if (apiData.message) {
        console.warn(`[Scheduler] ⚠️ API returned message: "${apiData.message}"`);
        return []; 
    }

    // Locate 'details'
    if (apiData.playlist && apiData.playlist.details) {
        detailsRaw = apiData.playlist.details;
    } 
    else if (apiData.details) {
        detailsRaw = apiData.details;
    }
    else if (Array.isArray(apiData)) {
        detailsRaw = apiData;
    }

    if (!detailsRaw) {
        console.warn("[Scheduler] ⚠️ Could not find 'details' in API response.");
        return [];
    }

    // Convert to Array
    let items = [];
    if (Array.isArray(detailsRaw)) {
        items = detailsRaw;
    } else if (typeof detailsRaw === 'object') {
        items = Object.values(detailsRaw);
    }

    console.log(`[Scheduler] Found ${items.length} raw items. Processing...`);

    // Map to Downloader Format (preserve raw data for metadata extraction)
    // Uses audio_id as deterministic filename for both audio and metadata files
    const validItems = items.map((item, index) => {
        const sourceId = item.fileName || item.preview_filename;
        const audioId = item.audio_id;
        let targetName = null;

        // Primary: Use audio_id as filename (deterministic link to metadata)
        if (audioId && sourceId) {
            const ext = path.extname(sourceId) || '.mp3';
            targetName = `${audioId}${ext}`;
        }
        // Fallback: Use existing filename_as or derive from sourceId
        else if (!targetName) {
            if (item.filename_as) targetName = item.filename_as;
            else if (item.filename) targetName = item.filename;
            else if (sourceId) targetName = sourceId.replace('AWE--', '').replace('IDO--', '').replace('HEL--', '');
            else targetName = `track_${index}.mp3`;
        }
        
        if (targetName) targetName = targetName.replace(/[<>:"/\\|?*]/g, '');

        if (!sourceId) return null;

        if (targetName && targetName.endsWith('.norm')) {
            return null; 
        }

        return {
            fileName: sourceId,
            filename_as: targetName,
            audio_id: audioId,
            fileExists: false,
            // Preserve raw item data for metadata extraction
            _raw: item
        };
    }).filter(item => item !== null);

    console.log(`[Scheduler] Extracted ${validItems.length} valid songs for download.`);
    return validItems;
};

/**
 * The Main Logic
 */
export const runSmartSync = async () => {
    const now = getRadioTime(); 
    const currentMinute = now.getMinutes();

    console.log(`\n--- [Scheduler] Running Smart Sync (Virtual Time: ${now.toLocaleTimeString()}) ---`);

    // --- 1. DOWNLOAD CURRENT HOUR ---
    const currentData = await syncMetadata(now);
    
    if (currentData) {
        const songList = extractSongsFromData(currentData);
        
        // METRICS: Capture state BEFORE download starts
        const startTime = Date.now();
        const initialTotalDownloads = state.downloadStats.totalSongs; 
        const initialTotalBytes = state.downloadStats.totalBytes; // <--- From your store.js
        
        try {
            await downloadMissingSongs(songList);
            
            // METRICS: Calculate Deltas
            const newDownloads = state.downloadStats.totalSongs - initialTotalDownloads;
            const dataUsed = state.downloadStats.totalBytes - initialTotalBytes;
            const timeString = getTimeString(startTime);

            console.log(`--- [Scheduler] Sync check done. ---`);
            console.log(`    ⏱️ Time Taken: ${timeString}`);
            console.log(`    📦 Processed: ${songList.length} items (${newDownloads} new downloaded)`);
            console.log(`    💾 Data Used: ${formatBytes(dataUsed)}`); // <--- Tracks bandwidth for this session
            
            console.log(`    📊 Net Stats: ${state.downloadStats.totalSongs} total downloaded`);
            console.log(`    🚀 Speed: ${state.downloadStats.lastSpeed} KB/s | ⚡ Latency: ${state.downloadStats.lastLatency}ms`);
            
        } catch (err) {
            console.error("Bg Download Error:", err);
            console.log(`    ⚠️ Errors: ${state.downloadStats.errors}`);
        }
    }

    // --- 2. NEXT HOUR PRE-LOAD (Always) ---
    console.log(`[Scheduler] 🕒 Pre-loading Next Hour...`);
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1);

    const nextData = await syncMetadata(nextHour);
    if (nextData) {
        const nextSongList = extractSongsFromData(nextData);
        
        const nextStartTime = Date.now();
        const nextInitialTotal = state.downloadStats.totalSongs;
        const nextInitialBytes = state.downloadStats.totalBytes;

        try {
            await downloadMissingSongs(nextSongList);
            
            const nextNewDownloads = state.downloadStats.totalSongs - nextInitialTotal;
            const nextDataUsed = state.downloadStats.totalBytes - nextInitialBytes;
            const nextTimeString = getTimeString(nextStartTime);

            console.log(`    ✅ Next Hour Pre-load: ${nextSongList.length} items (${nextNewDownloads} new, ${formatBytes(nextDataUsed)}) in ${nextTimeString}`);
        } catch (err) {
            console.error("Next Hour Bg Download Error:", err);
        }
    }
    
    console.log(`--- [Scheduler] All Sync Tasks Completed ---\n`);
};