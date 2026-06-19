import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET || "fallback-dev-secret";

/**
 * Express middleware to intercept res.json and dynamically format names of users
 * whom the requesting user has added (i.e. has a DM room or ContactLink with).
 */
export async function setupResponseNameFormatter(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.split(" ")[1];
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.id;
  } catch (err) {
    return next();
  }

  const originalJson = res.json;
  res.json = async function (data) {
    try {
      // 1. Fetch display names map for the requesting user
      const nameMap = {};

      // 1.1 Direct message room participants
      const dmRooms = await prisma.room.findMany({
        where: {
          type: "DIRECT",
          participants: {
            some: { userId }
          }
        },
        include: {
          participants: {
            include: {
              user: { select: { id: true, name: true, username: true } }
            }
          }
        }
      });

      dmRooms.forEach(room => {
        room.participants.forEach(p => {
          if (p.userId !== userId) {
            const u = p.user;
            const firstName = u.name ? u.name.trim().split(/\s+/)[0] : `@${u.username}`;
            nameMap[u.id] = firstName;
          }
        });
      });

      // 1.2 Explicit ContactLinks
      const links = await prisma.contactLink.findMany({
        where: { userId },
        include: {
          contact: { select: { id: true, name: true, username: true } }
        }
      });

      links.forEach(link => {
        if (link.customName) {
          nameMap[link.contactId] = link.customName;
        } else if (link.contact) {
          const u = link.contact;
          const firstName = u.name ? u.name.trim().split(/\s+/)[0] : `@${u.username}`;
          nameMap[u.id] = firstName;
        }
      });

      // Recursive helper to map display names
      function applyDisplayNames(obj) {
        if (!obj || typeof obj !== "object") return obj;

        if (Array.isArray(obj)) {
          for (let i = 0; i < obj.length; i++) {
            obj[i] = applyDisplayNames(obj[i]);
          }
          return obj;
        }

        if (obj.id && obj.username && "name" in obj) {
          if (obj.id !== userId && nameMap[obj.id]) {
            obj.name = nameMap[obj.id];
          }
        }

        for (const key of Object.keys(obj)) {
          if (typeof obj[key] === "object" && obj[key] !== null) {
            obj[key] = applyDisplayNames(obj[key]);
          }
        }

        return obj;
      }

      const processed = applyDisplayNames(data);
      return originalJson.call(this, processed);
    } catch (error) {
      console.error("[Middleware] Name formatter error:", error);
      return originalJson.call(this, data);
    }
  };

  next();
}
