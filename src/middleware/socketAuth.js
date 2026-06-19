import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-dev-secret";

/**
 * Socket.io middleware — validates JWT from socket.handshake.auth.token.
 * Attaches userId to socket instance.
 */
export function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error("Authentication required."));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.id;
    socket.userName = decoded.name || decoded.email;
    next();
  } catch (err) {
    return next(new Error("Invalid or expired token."));
  }
}
