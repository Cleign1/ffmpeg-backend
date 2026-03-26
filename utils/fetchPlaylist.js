import { CONFIG } from "../config.js";

/**
 * Fetch Playlist dari API Playlist Radio.cloud
 * @param {string} externalURL - URL untuk apinya
 * @param {string} date - Tanggal dalam format YYYY-MM-DD
 * @param {number} hours - Jam dalam format 24 jam
 * @returns {object} data - Data playlist}
 */

export const fetchPlaylist = async (externalURL, date, hours) => {
    // 1. Log the inputs to ensure they aren't undefined
    console.log(`[API] Starting Fetch...`);
    console.log(`      > Base URL: ${externalURL}`);
    console.log(`      > Date: ${date}, Hour: ${hours}`);

    if (!externalURL) {
        throw new Error("External URL is missing or undefined.");
    }

    // 2. Construct and Log the full URL
    // Ensure we don't end up with double slashes like 'url//date'
    const cleanUrl = externalURL.replace(/\/$/, '');
    const radioID = CONFIG.RADIO_CHANNEL_ID
    const url = `${cleanUrl}/${date}/${hours}/${radioID}`;
    
    console.log(`[API] Full URL: ${url}`);

    try {
        const response = await fetch(url);

        // 3. Log the Status Code
        console.log(`[API] Response Status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            // 4. If error, try to read the response body (it might contain the error reason)
            const errorText = await response.text();
            console.error(`[API] ❌ Server returned error body:`, errorText);
            throw new Error(`API Error ${response.status}: ${response.statusText}`);
        }

        // 5. Attempt to parse JSON
        const data = await response.json();
        console.log(`[API] ✅ Successfully parsed JSON. Items: ${Array.isArray(data) ? data.length : 'Unknown'}`);
        return data;

    } catch (error) {
        // 6. detailed error logging
        console.error('--- [API] FATAL ERROR ---');
        console.error('Message:', error.message);
        console.error('Cause:', error.cause);
        throw error;
    }
}