import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import { fetchPlaylist } from '../utils/fetchPlaylist.js';
import { getZonedDateParts, getZonedTimestamp } from '../utils/time.js';

// Ensure Data Dir Exists
if (!fs.existsSync(CONFIG.DATA_DIR)) {
        fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

// Accept a 'targetDate' parameter (Default = now)
export const syncMetadata = async (targetDate) => {
    // Safety: If no date provided, use current real time, OR you could import getRadioTime()
    const dateObj = targetDate || new Date(); 

    // Extract strings from the requested date using broadcast time zone
    const { dateStr, hourStr } = getZonedDateParts(dateObj, CONFIG.TIME_ZONE);

    console.log(`[Metadata] Syncing for: ${dateStr} @ ${hourStr}:00`);
    
    try {
        if (!CONFIG.PLAYLIST_URL) {
            console.warn("[Metadata] No API_PLAYLIST_URL defined.");
            return null;
        }

        const apiData = await fetchPlaylist(CONFIG.PLAYLIST_URL, dateStr, hourStr);

        if (apiData) {
            // Generate filename with specific Hour info
            const currentTimestamp = getZonedTimestamp(new Date(), CONFIG.TIME_ZONE);
            const filename = `playlist_${hourStr}_${dateStr}_${currentTimestamp}_${CONFIG.RADIO_NETWORK_CODE}.json`;
            const filePath = path.join(CONFIG.DATA_DIR, filename);

            // Save to disk
            fs.writeFileSync(filePath, JSON.stringify(apiData, null, 2));
            console.log(`[Metadata] Saved: ${filename}`);
            
            return apiData;
        }

    } catch (error) {
        console.error(`[Metadata] Sync Failed for ${hourStr}:00 -`, error.message);
        return null;
    }
};