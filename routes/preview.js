import express from 'express';
import path from 'path';
import fs from 'fs';
import { CONFIG } from '../config.js';

const router = express.Router();

/**
 * Get metadata sidecar JSON for a song
 * GET /api/preview/metadata/:filename
 * Uses audio_id-based naming: audio file "7807691.mp3" -> metadata "7807691.json"
 */
router.get('/preview/metadata/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const metadataDir = path.join(CONFIG.DATA_DIR, 'metadata');
        
        // Check if metadata directory exists
        if (!fs.existsSync(metadataDir)) {
            return res.status(404).json({
                success: false,
                error: 'Metadata directory not found'
            });
        }

        // Extract base name without extension from the audio filename
        // Audio files are now named by audio_id: "7807691.mp3"
        const audioBaseName = path.basename(filename, path.extname(filename));
        
        // Primary: Direct match with audio_id.json (deterministic link)
        const expectedMetaName = `${audioBaseName}.json`;
        const metadataPath = path.join(metadataDir, expectedMetaName);
        
        if (fs.existsSync(metadataPath)) {
            const content = fs.readFileSync(metadataPath, 'utf-8');
            const metadata = JSON.parse(content);

            return res.json({
                success: true,
                filename: expectedMetaName,
                metadata
            });
        }

        // Fallback: Search all metadata files for matching audio_id field
        const metadataFiles = fs.readdirSync(metadataDir).filter(f => f.endsWith('.json'));
        
        for (const file of metadataFiles) {
            try {
                const filePath = path.join(metadataDir, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                const meta = JSON.parse(content);
                
                // Check if audio_id matches or fileName contains the audioBaseName
                if (meta.audio_id && String(meta.audio_id) === audioBaseName) {
                    return res.json({
                        success: true,
                        filename: file,
                        metadata: meta
                    });
                }
            } catch (e) {
                // Skip malformed JSON files
                continue;
            }
        }

        return res.status(404).json({
            success: false,
            error: 'Metadata file not found'
        });

    } catch (error) {
        console.error('Metadata fetch error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch metadata'
        });
    }
});

/**
 * Stream audio file for preview (needed for HTML5 audio element)
 * GET /api/preview/audio/:filename
 */
router.get('/preview/audio/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(CONFIG.SONGS_DIR, filename);

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                error: 'File not found'
            });
        }

        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            // Handle range request for seeking
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mpeg',
            };

            res.writeHead(206, head);
            file.pipe(res);
        } else {
            // Stream entire file
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
            };

            res.writeHead(200, head);
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (error) {
        console.error('Audio streaming error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to stream audio file'
        });
    }
});

export default router;
