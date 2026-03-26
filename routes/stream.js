
// routes/stream.js
import express from 'express';
import { state } from '../store.js';

const router = express.Router();

router.get('/stream', (req, res) => {
    // 1. Setup Headers
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setKeepAlive(true, 0);
    }
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // 2. Add to active clients
    state.clients.add(res);
    console.log(`[Stream] 🎧 New listener. Total: ${state.clients.size}`);

    // 3. REMOVE on close (CRITICAL)
    req.on('close', () => {
        state.clients.delete(res);
        console.log(`[Stream] 🔌 Listener disconnected. Total: ${state.clients.size}`);
    });
});

export default router;