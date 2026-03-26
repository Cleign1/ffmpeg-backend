import fs from 'fs/promises';
import path from 'path';
import { CONFIG } from '../config.js';

/**
 * MetadataExtractor Service
 * 
 * Purpose: Process playlist JSON data and generate standalone JSON sidecar files
 * for each individual song. These sidecar files contain extracted metadata that
 * can be used by other parts of the system without needing to parse the full playlist.
 * 
 * Output Schema:
 * {
 *   audio_id: number | null,
 *   artist: string,
 *   title: string,
 *   category: string,
 *   genres: string[] | null,
 *   cutIn: number,
 *   cutOut: number,
 *   intro: number | null,
 *   mix_point_pr_ev: number,
 *   fileName: string,
 *   extractedAt: string (ISO timestamp)
 * }
 */

// Default values for missing fields
const DEFAULTS = {
    artist: 'Unknown Artist',
    title: 'Unknown Title',
    category: 'Music',
    genres: null,
    cutIn: 0,
    cutOut: 0,
    intro: null,
    mix_point_pr_ev: 0,
    audio_id: null,
    fileName: null
};

/**
 * Safely extracts a numeric value from source data
 * @param {any} value - The value to parse
 * @param {number} defaultValue - Fallback if parsing fails
 * @returns {number}
 */
const safeNumber = (value, defaultValue = 0) => {
    if (value === null || value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
};

/**
 * Safely extracts a string value from source data
 * @param {any} value - The value to parse
 * @param {string} defaultValue - Fallback if value is empty
 * @returns {string}
 */
const safeString = (value, defaultValue = '') => {
    if (value === null || value === undefined) return defaultValue;
    const str = String(value).trim();
    return str || defaultValue;
};

/**
 * Safely extracts genres array from source data
 * @param {any} value - The value to parse (could be array, string, or null)
 * @returns {string[] | null}
 */
const safeGenres = (value) => {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.filter(g => typeof g === 'string' && g.trim());
    if (typeof value === 'string' && value.trim()) {
        // Handle comma-separated string
        return value.split(',').map(g => g.trim()).filter(Boolean);
    }
    return null;
};

/**
 * Generates a unique filename for the sidecar JSON
 * Uses audio_id as primary identifier for deterministic linking with audio files
 * @param {object} sourceItem - The source playlist item
 * @returns {string}
 */
const generateSidecarFilename = (sourceItem) => {
    const audioId = sourceItem.audio_id;
    const fileName = sourceItem.filename_as || sourceItem.fileName || sourceItem.preview_filename;
    
    // Primary: Use audio_id for deterministic linking (matches audio filename)
    if (audioId) {
        return `${audioId}.json`;
    }
    
    // Fallback 1: Use fileName base (prioritize the actual stored filename)
    if (fileName) {
        // Remove extension and sanitize
        const baseName = path.basename(fileName, path.extname(fileName));
        const sanitized = baseName.replace(/[<>:"/\\|?*]/g, '').trim();
        return `${sanitized}.json`;
    }
    
    // Fallback 2: Generate timestamp-based name
    return `unknown_${Date.now()}.json`;
};

/**
 * Extracts metadata from a single source item and formats it according to schema
 * @param {object} sourceItem - Raw item from playlist details
 * @returns {object} Formatted metadata object
 */
export const extractMetadata = (sourceItem) => {
    if (!sourceItem || typeof sourceItem !== 'object') {
        console.warn('[MetadataExtractor] ⚠️ Invalid source item provided');
        return null;
    }

    return {
        audio_id: safeNumber(sourceItem.audio_id, DEFAULTS.audio_id),
        artist: safeString(sourceItem.artist, DEFAULTS.artist),
        title: safeString(sourceItem.title, DEFAULTS.title),
        category: safeString(sourceItem.category || sourceItem.bc_category, DEFAULTS.category),
        genres: safeGenres(sourceItem.genres),
        cutIn: safeNumber(sourceItem.cutIn, DEFAULTS.cutIn),
        cutOut: safeNumber(sourceItem.cutOut, DEFAULTS.cutOut),
        intro: sourceItem.intro !== null && sourceItem.intro !== undefined 
            ? safeNumber(sourceItem.intro, null) 
            : DEFAULTS.intro,
        mix_point_pr_ev: safeNumber(sourceItem.mix_point_pr_ev, DEFAULTS.mix_point_pr_ev),
        fileName: safeString(sourceItem.filename_as || sourceItem.fileName || sourceItem.preview_filename, DEFAULTS.fileName),
        extractedAt: new Date().toISOString()
    };
};

/**
 * Saves metadata to a JSON sidecar file
 * @param {object} metadata - The extracted metadata object
 * @param {string} outputDir - Directory to save the file (defaults to CONFIG.DATA_DIR/metadata)
 * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
 */
export const saveMetadataFile = async (metadata, outputDir = null) => {
    if (!metadata) {
        return { success: false, error: 'No metadata provided' };
    }

    const targetDir = outputDir || path.join(CONFIG.DATA_DIR, 'metadata');
    
    try {
        // Ensure output directory exists
        await fs.mkdir(targetDir, { recursive: true });
        
        const filename = generateSidecarFilename(metadata);
        const filePath = path.join(targetDir, filename);
        
        // Write with pretty formatting for readability
        await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), 'utf-8');
        
        console.log(`[MetadataExtractor] 💾 Saved: ${filename}`);
        return { success: true, filePath };
        
    } catch (error) {
        console.error(`[MetadataExtractor] ❌ Failed to save metadata:`, error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Processes a single track and generates its metadata sidecar file
 * This is the main integration point for the downloader
 * @param {object} sourceItem - Raw item from playlist details
 * @param {string} outputDir - Optional custom output directory
 * @returns {Promise<{success: boolean, metadata?: object, filePath?: string, error?: string}>}
 */
export const processTrackMetadata = async (sourceItem, outputDir = null) => {
    try {
        const metadata = extractMetadata(sourceItem);
        
        if (!metadata) {
            return { success: false, error: 'Failed to extract metadata' };
        }
        
        const saveResult = await saveMetadataFile(metadata, outputDir);
        
        if (saveResult.success) {
            return { 
                success: true, 
                metadata, 
                filePath: saveResult.filePath 
            };
        }
        
        return saveResult;
        
    } catch (error) {
        console.error(`[MetadataExtractor] ❌ Process failed:`, error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Batch processes multiple tracks from playlist data
 * Useful for processing entire playlist at once
 * @param {object} apiData - Raw API response data (unwraps automatically)
 * @param {string} outputDir - Optional custom output directory
 * @returns {Promise<{processed: number, failed: number, results: Array}>}
 */
export const processPlaylistMetadata = async (apiData, outputDir = null) => {
    const results = [];
    let processed = 0;
    let failed = 0;

    // --- Unwrap API Data (same logic as scheduler.js) ---
    let data = apiData;
    
    // Unwrap Array
    if (Array.isArray(data) && data.length > 0) {
        if (data[0].details || data[0].version || data[0].playlist) {
            data = data[0];
        }
    }

    // Unwrap Dynamic Hour Key
    const keys = Object.keys(data);
    if (keys.length === 1 && !isNaN(parseInt(keys[0]))) {
        data = data[keys[0]];
    }

    // Check for error message
    if (data.message && !data.details && !data.playlist) {
        console.warn(`[MetadataExtractor] ⚠️ API message: "${data.message}"`);
        return { processed: 0, failed: 0, results: [] };
    }

    // Locate 'details'
    let detailsRaw = null;
    if (data.playlist && data.playlist.details) {
        detailsRaw = data.playlist.details;
    } else if (data.details) {
        detailsRaw = data.details;
    } else if (Array.isArray(data)) {
        detailsRaw = data;
    }

    if (!detailsRaw) {
        console.warn("[MetadataExtractor] ⚠️ Could not find 'details' in data.");
        return { processed: 0, failed: 0, results: [] };
    }

    // Convert to Array
    const items = Array.isArray(detailsRaw) ? detailsRaw : Object.values(detailsRaw);
    
    console.log(`[MetadataExtractor] 📋 Processing metadata for ${items.length} tracks...`);

    // Process in parallel with concurrency limit
    const BATCH_SIZE = 10;
    
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
            batch.map(async (item) => {
                const result = await processTrackMetadata(item, outputDir);
                return { item, result };
            })
        );
        
        batchResults.forEach(({ item, result }) => {
            if (result.success) {
                processed++;
            } else {
                failed++;
                console.warn(`[MetadataExtractor] ⚠️ Failed for: ${item.title || item.fileName || 'unknown'}`);
            }
            results.push(result);
        });
    }

    console.log(`[MetadataExtractor] ✅ Complete: ${processed} processed, ${failed} failed`);
    
    return { processed, failed, results };
};

/**
 * Checks if a metadata sidecar file already exists for a track
 * @param {object} sourceItem - The source item to check
 * @param {string} outputDir - Optional custom output directory
 * @returns {Promise<boolean>}
 */
export const hasMetadataFile = async (sourceItem, outputDir = null) => {
    const targetDir = outputDir || path.join(CONFIG.DATA_DIR, 'metadata');
    const filename = generateSidecarFilename(sourceItem);
    const filePath = path.join(targetDir, filename);
    
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

/**
 * Reads an existing metadata sidecar file
 * @param {object} sourceItem - The source item (used to derive filename)
 * @param {string} outputDir - Optional custom output directory
 * @returns {Promise<object | null>}
 */
export const readMetadataFile = async (sourceItem, outputDir = null) => {
    const targetDir = outputDir || path.join(CONFIG.DATA_DIR, 'metadata');
    const filename = generateSidecarFilename(sourceItem);
    const filePath = path.join(targetDir, filename);
    
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return null;
    }
};

// Default export for convenience
export default {
    extractMetadata,
    saveMetadataFile,
    processTrackMetadata,
    processPlaylistMetadata,
    hasMetadataFile,
    readMetadataFile
};
