import express from 'express';
import { state } from '../store.js';

const router = express.Router();

/**
 * Deconstructed api.js route, this one is for playlist
 * what is currently playing is displayed on this page
 */
router.get('/playlist', (req, res) => {
    res.json(state.playlist);
});

export default router;