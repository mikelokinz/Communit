import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import authRoutes from "./src/routes/auth.js";
import roomRoutes from "./src/routes/rooms.js";
import meetingRoutes from "./src/routes/meetings.js";
import fileRoutes from "./src/routes/files.js";
import { registerChatHandlers } from "./src/handlers/chat.js";
import { authenticateSocket } from "./src/middleware/socketAuth.js";
import { setupResponseNameFormatter } from "./src/middleware/nameFormatter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// This tells your backend to serve any HTML/CSS/JS files placed in a folder named 'public'
app.use(express.static('public'));
const httpServer = createServer(app);
const port = parseInt(process.env.PORT || "3000", 10);

// Middleware
/*
// Allow Netlify to communicate with backend
app.use(cors({
  origin: "https://communitat.netlify.app", // Your exact live frontend URL
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"]
}));
*/
app.use(express.json({ limit: "50mb" }));
app.use(setupResponseNameFormatter);

// Attach socket.io to req object
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/meetings", meetingRoutes);
app.use("/api/files", fileRoutes);

// Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Socket.io JWT authentication middleware
io.use(authenticateSocket);

// Socket.io connection handler
io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id} | User: ${socket.userId}`);

  registerChatHandlers(io, socket);

  socket.on("disconnect", (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} | Reason: ${reason}`);
  });
});

// Start server
httpServer.listen(port, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   COMMUNIT SERVER ACTIVE             ║`);
  console.log(`  ║   http://localhost:${port}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
