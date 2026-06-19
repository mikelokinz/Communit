import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const results = [];

function log(label, status, detail = "") {
  const icon = status === "OK" ? "✅" : "❌";
  const line = `  ${icon}  ${label}${detail ? " — " + detail : ""}`;
  results.push({ label, status, detail });
  console.log(line);
}

async function testDatabase() {
  console.log("\n─── DATABASE (PostgreSQL via Prisma) ───");
  try {
    await prisma.$connect();
    log("Prisma connect", "OK");
  } catch (err) {
    log("Prisma connect", "FAIL", err.message);
    return;
  }

  try {
    const raw = await prisma.$queryRaw`SELECT NOW() AS server_time`;
    log("Raw SQL query", "OK", `Server time: ${raw[0].server_time}`);
  } catch (err) {
    log("Raw SQL query", "FAIL", err.message);
  }

  // Check tables exist
  try {
    const tables = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name`;
    const names = tables.map((t) => t.table_name);
    if (names.length === 0) {
      log("Tables", "FAIL", "No tables found — run `npx prisma db push`");
    } else {
      log("Tables", "OK", names.join(", "));
    }
  } catch (err) {
    log("Tables check", "FAIL", err.message);
  }

  // Quick model counts
  for (const model of ["user", "room", "message", "roomParticipant", "contactLink", "userSession"]) {
    try {
      const count = await prisma[model].count();
      log(`${model} count`, "OK", `${count} rows`);
    } catch (err) {
      log(`${model} count`, "FAIL", err.message);
    }
  }
}

async function testExpressAndSocket() {
  console.log("\n─── EXPRESS + SOCKET.IO ───");

  // Dynamically import the server deps
  const { createServer } = await import("node:http");
  const express = (await import("express")).default;
  const { Server } = await import("socket.io");
  const { io: ioClient } = await import("socket.io-client");

  const app = express();
  const httpServer = createServer(app);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const io = new Server(httpServer, { cors: { origin: "*" } });

  return new Promise((resolve) => {
    httpServer.listen(0, async () => {
      const addr = httpServer.address();
      const baseUrl = `http://localhost:${addr.port}`;

      // Test Express
      try {
        const resp = await fetch(`${baseUrl}/health`);
        const data = await resp.json();
        if (data.status === "ok") {
          log("Express HTTP server", "OK", `listening on port ${addr.port}`);
        } else {
          log("Express HTTP server", "FAIL", "unexpected response");
        }
      } catch (err) {
        log("Express HTTP server", "FAIL", err.message);
      }

      // Test Socket.IO (no auth on this test server)
      try {
        const socket = ioClient(baseUrl, { transports: ["websocket"], timeout: 3000 });
        await new Promise((res, rej) => {
          const timer = setTimeout(() => { socket.disconnect(); rej(new Error("timeout")); }, 3000);
          socket.on("connect", () => { clearTimeout(timer); res(); });
          socket.on("connect_error", (e) => { clearTimeout(timer); rej(e); });
        });
        log("Socket.IO WebSocket", "OK", `connected as ${socket.id}`);
        socket.disconnect();
      } catch (err) {
        log("Socket.IO WebSocket", "FAIL", err.message);
      }

      httpServer.close();
      resolve();
    });
  });
}

async function testJWT() {
  console.log("\n─── JWT CONFIG ───");
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) {
    log("JWT_SECRET", "OK", `set (${secret.length} chars)`);
  } else if (secret) {
    log("JWT_SECRET", "FAIL", `too short (${secret.length} chars, need ≥16)`);
  } else {
    log("JWT_SECRET", "FAIL", "not set in .env");
  }
}

// ── Run all tests ──
console.log("\n╔══════════════════════════════════════════╗");
console.log("║   COMMUNIT — CONNECTION TEST SUITE       ║");
console.log("╚══════════════════════════════════════════╝");

try {
  await testDatabase();
  await testExpressAndSocket();
  await testJWT();
} catch (err) {
  console.error("\n⚠️  Unexpected error:", err);
} finally {
  await prisma.$disconnect();
}

// Summary
const passed = results.filter((r) => r.status === "OK").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n═══════════════════════════════════════════`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${results.length} total`);
console.log(`═══════════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
