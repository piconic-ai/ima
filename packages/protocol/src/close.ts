/**
 * WebSocket close code sent to everyone in a room when its host leaves.
 * Clients must not reconnect on it: the session is over.
 */
export const ROOM_CLOSED = 4001
