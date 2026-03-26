import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { CONFIG } from '../config.js';
import { state } from '../store.js';
import { processTrackMetadata } from '../services/metadataExtractor.js';

// 🔒 LOCK SYSTEM: Tracks files currently being downloaded to prevent overlaps
const activeDownloads = new Set();

// Helper: Pause execution for X ms
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 🛠️ WORKER: Downloads a SINGLE song with Resume & Retry logic
 */
export const downloadSong = async (fileName, filename_as, attempt = 1) => {
    const MAX_RETRIES = 5;
    
    // Safety Check
    if (!fileName || !filename_as) return { success: false, reason: "Invalid Input" };

    // 🔒 CHECK LOCK: If this file is already downloading, skip it silently
    if (activeDownloads.has(filename_as)) {
        // console.log(`[Downloader] ⏭️ Skipped duplicate request: ${filename_as}`);
        return { success: true, reason: "Already in progress" };
    }

    const finalDest = path.join(CONFIG.SONGS_DIR, filename_as);
    const tempDest = path.join(CONFIG.SONGS_DIR, `${filename_as}.part`);

    // 1. Check if finalized file already exists
    if (fs.existsSync(finalDest)) {
        const stats = fs.statSync(finalDest);
        if (stats.size > 0) return { success: true, cached: true };
        try { fs.unlinkSync(finalDest); } catch(e){} 
    }

    // 🔒 SET LOCK
    activeDownloads.add(filename_as);

    // METRICS: Start Timer
    const startTime = Date.now();
    let ttfb = 0;
    
    try {
        state.downloadStats.activeDownloads++;

        // 2. Get Signed URL
        const queryString = [
            `preview_filename=${encodeURIComponent(fileName)}`,
            `pine=${encodeURIComponent(CONFIG.RADIO_PINE)}`,
            `network_id=${encodeURIComponent(CONFIG.RADIO_NETWORK_ID)}`,
            `network_code=${encodeURIComponent(CONFIG.RADIO_NETWORK_CODE)}`,
            `local_id=${encodeURIComponent(CONFIG.RADIO_LOCAL_ID)}`,
            `filename=${encodeURIComponent(filename_as)}`
        ].join('&');

        const apiEndpoint = `${CONFIG.AUDIO_API_BASE}audioPreview?${queryString}`;
        
        if (attempt === 1) console.log(`[Downloader] ⬇️  Queueing: ${filename_as}`);
        
        let apiResponse = await fetch(apiEndpoint);
        if (!apiResponse.ok) throw new Error(`Link Fetch Failed: ${apiResponse.status}`);
        let apiJson = await apiResponse.json();

        // 🛑 Handle "Reprocess"
        if (apiJson.status === "Failed" && apiJson.message === "Reprocess") {
            if (attempt < MAX_RETRIES) {
                console.log(`[Downloader] ⏳ Server preparing file. Waiting ${3 * attempt}s...`);
                await wait(3000 * attempt);
                // RELEASE LOCK before recursive retry so the retry can claim it
                activeDownloads.delete(filename_as);
                state.downloadStats.activeDownloads--;
                return downloadSong(fileName, filename_as, attempt + 1);
            }
            throw new Error("Stuck in Reprocess Loop");
        }

        const s3Url = apiJson.message;

        // 3. ⏯️ RESUME LOGIC
        let headers = {};
        let startByte = 0;
        let fileMode = 'w';

        if (fs.existsSync(tempDest)) {
            const stats = fs.statSync(tempDest);
            startByte = stats.size;
            if (startByte > 0) {
                headers['Range'] = `bytes=${startByte}-`;
                fileMode = 'a';
                console.log(`[Downloader] ⏩ Resuming ${filename_as} from ${(startByte / 1024).toFixed(1)} KB`);
            }
        }

        const fetchStart = Date.now();
        const fileResponse = await fetch(s3Url, { headers });
        ttfb = Date.now() - fetchStart;

        if (!fileResponse.ok && fileResponse.status !== 206) {
            if (fileResponse.status === 416) {
                 fs.unlinkSync(tempDest);
                 throw new Error("Invalid Range (Restarting)");
            }
            throw new Error(`S3 Error: ${fileResponse.status}`);
        }

        const totalSize = parseInt(fileResponse.headers.get('content-length'), 10) + startByte;
        
        // 4. Stream & Write
        const fileStream = fs.createWriteStream(tempDest, { flags: fileMode });

        await new Promise((resolve, reject) => {
            Readable.fromWeb(fileResponse.body).pipe(fileStream);
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
        });

        // 5. Atomic Rename (.part -> .mp3)
        // Check if file exists one last time to be safe
        if (fs.existsSync(tempDest)) {
            fs.renameSync(tempDest, finalDest);
        } else {
             throw new Error("Temp file vanished before rename");
        }

        // METRICS
        const endTime = Date.now();
        const duration = endTime - startTime;
        const downloadedBytes = totalSize - startByte;
        const speed = duration > 0 ? (downloadedBytes / 1024) / (duration / 1000) : 0;

        state.downloadStats.totalSongs++;
        state.downloadStats.totalBytes += downloadedBytes;
        state.downloadStats.lastSpeed = Math.round(speed);
        state.downloadStats.lastLatency = ttfb;
        state.downloadStats.activeDownloads--;

        console.log(`[Downloader] ✅ Saved: ${filename_as} | ⚡ ${ttfb}ms | 🚀 ${Math.round(speed)} KB/s`);

        return { success: true };

    } catch (error) {
        state.downloadStats.activeDownloads--;
        
        // 🔄 RETRY LOGIC
        if (attempt < MAX_RETRIES) {
            state.downloadStats.errors++;
            const backoff = 2000 * attempt;
            console.warn(`[Downloader] ⚠️ Issue with ${filename_as}: ${error.message}. Retry in ${backoff/1000}s...`);
            await wait(backoff);
            
            // Release lock so retry can run
            activeDownloads.delete(filename_as);
            return downloadSong(fileName, filename_as, attempt + 1);
        }
        
        console.error(`[Downloader] ❌ FAILED ${filename_as}: ${error.message}`);
        return { success: false, reason: error.message };
    } finally {
        // 🔓 ALWAYS RELEASE LOCK
        // We check if it exists in the set to avoid deleting a lock set by a recursive retry
        // (Though in this logic, we delete explicitly before recursing, so this is safe)
        activeDownloads.delete(filename_as);
    }
};

/**
 * 🚀 MANAGER: Parallel Batch Downloader
 * Now also generates metadata sidecar files for each downloaded track
 */
export const downloadMissingSongs = async (playlist, rawPlaylistData = null) => {
    // 1. Filter Logic
    const missingItems = playlist.filter(track => {
        if (!track.filename_as && !track.filename) return false;
        const targetName = track.filename_as || track.filename;
        if (targetName.endsWith('.norm')) return false; 
        
        // Check if file exists ON DISK
        const dest = path.join(CONFIG.SONGS_DIR, targetName);
        if (fs.existsSync(dest)) return false;

        // Check if ALREADY DOWNLOADING (Optimization)
        if (activeDownloads.has(targetName)) return false;

        return true;
    });

    if (missingItems.length === 0) return;

    console.log(`[Downloader] 📦 Batch Processing: ${missingItems.length} songs missing.`);
    
    // 2. Parallel Batch Loop
    const BATCH_SIZE = 10; 
    
    for (let i = 0; i < missingItems.length; i += BATCH_SIZE) {
        const batch = missingItems.slice(i, i + BATCH_SIZE);
        console.log(`[Downloader] 🔄 Starting Batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(missingItems.length/BATCH_SIZE)} (${batch.length} files)...`);

        await Promise.all(batch.map(async (track) => {
            const targetName = track.filename_as || track.filename;
            const result = await downloadSong(track.fileName, targetName);
            
            if (result.success) {
                track.fileExists = true;
                
                // 📋 Extract and save metadata sidecar file
                // Use raw track data if available (contains full metadata)
                const rawTrack = { ...(track._raw || track) };

                // Ensure metadata ties back to the stored filename and numeric audio_id when possible
                if (targetName) {
                    rawTrack.fileName = targetName; // deterministic link to on-disk file
                    const base = path.basename(targetName, path.extname(targetName));
                    if (/^\d+$/.test(base)) {
                        rawTrack.audio_id = rawTrack.audio_id || parseInt(base, 10);
                    }
                }
                try {
                    await processTrackMetadata(rawTrack);
                } catch (metaErr) {
                    // Don't fail the download if metadata extraction fails
                    console.warn(`[Downloader] ⚠️ Metadata extraction skipped for ${targetName}: ${metaErr.message}`);
                }
            }
        }));
    }
    console.log("[Downloader] 🏁 All batches finished.");
};