/**
 * socket.js — Socket.io client singleton
 * Connects with JWT token for authenticated real-time communication.
 */

import { getToken } from "./auth.js";

let socket = null;

/**
 * Get or create the Socket.io client instance.
 * Loads socket.io-client from CDN on first call.
 */
export async function getSocket() {
  if (socket && socket.connected) {
    return socket;
  }

  // Wait for io to be available (loaded via <script> tag in HTML)
  if (typeof io === "undefined") {
    throw new Error("Socket.io client library not loaded.");
  }

  const token = getToken();

  if (!token) {
    throw new Error("No auth token available for socket connection.");
  }

  const socketUrl = "";

  socket = io(socketUrl, {
    auth: { token },
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity
  });

  // Connection lifecycle logging
  socket.on("connect", () => {
    console.log("[Socket] Connected:", socket.id);
  });

  socket.on("disconnect", (reason) => {
    console.log("[Socket] Disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.error("[Socket] Connection error:", err.message);
  });

  socket.on("error", (data) => {
    console.error("[Socket] Server error:", data.message);
  });

  socket.connect();
  return socket;
}

/**
 * Disconnect and cleanup the socket.
 */
export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
