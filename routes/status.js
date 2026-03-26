// routes/status.js
import express from 'express';
import { state } from '../store.js';

const router = express.Router();

router.get('/status', (req, res) => {
    const currentTrack = state.currentTrack || {};
    // Calculate progress
    const elapsed = state.radioStartTime ? (Date.now() - state.radioStartTime) / 1000 : 0;

    res.json({
        currentTrack: {
            ...currentTrack,
            id: state.playlist.indexOf(currentTrack) // Ensure ID matches array index
        },
        progress: elapsed,
        listeners: state.clients.size,
        
        playlistVersion: state.playlistVersion,
        isBroadcasting: state.isBroadcasting,
        downloadQueue: state.downloadStats.activeDownloads
    });
});

export default router;