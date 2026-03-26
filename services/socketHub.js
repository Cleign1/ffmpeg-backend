/**
 * services/socketHub.js
 * Lightweight singleton to register and retrieve the active Socket.IO server instance.
 * This allows other modules (e.g., library refreshers, playlist loaders) to emit events
 * without creating circular dependencies or re-instantiating Socket.IO.
 */

let ioInstance = null;

/**
 * Registers the Socket.IO server instance once it has been created.
 * @param {import("socket.io").Server} io
 */
export function setIoInstance(io) {
  ioInstance = io;
}

/**
 * Retrieves the registered Socket.IO server instance.
 * Throws if it has not been initialized to avoid silent failures.
 * @returns {import("socket.io").Server}
 */
export function getIoInstance() {
  if (!ioInstance) {
    throw new Error("[socketHub] Socket.IO instance has not been initialized yet.");
  }
  return ioInstance;
}

/**
 * Safe global emit. No-op if the instance is not ready.
 * @param {string} event
 * @param {*} payload
 */
export function emitGlobal(event, payload) {
  if (!ioInstance) return;
  ioInstance.emit(event, payload);
}

/**
 * Emit to a specific room/channel. No-op if the instance is not ready.
 * @param {string} room
 * @param {string} event
 * @param {*} payload
 */
export function emitToRoom(room, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(room).emit(event, payload);
}

/**
 * Emit directly to a socket ID. No-op if the instance is not ready.
 * @param {string} socketId
 * @param {string} event
 * @param {*} payload
 */
export function emitToSocket(socketId, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(socketId).emit(event, payload);
}
