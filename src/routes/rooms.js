import { Router } from "express";
import { prisma } from "../db.js";
import { authenticateRequest } from "../middleware/auth.js";

const router = Router();

// All room routes require authentication
router.use(authenticateRequest);

/**
 * POST /api/rooms
 * Body: { name, usernames? }
 * Creates a new GROUP room, assigns creator as HOST
 */
router.post("/", async (req, res) => {
  try {
    const { name, usernames } = req.body;
    const roomName = name || "Untitled Group";

    // Generate a unique slug
    const slug = generateSlug(roomName);
    
    // Find users by emails if provided
    let participantsData = [
      { userId: req.user.id, role: "HOST" }
    ];

    if (usernames && Array.isArray(usernames)) {
      const usersToAdd = await prisma.user.findMany({
        where: { username: { in: usernames } }
      });
      for (const u of usersToAdd) {
        if (u.id !== req.user.id) {
          participantsData.push({ userId: u.id, role: "GUEST" });
        }
      }
    }

    const room = await prisma.room.create({
      data: {
        name: roomName,
        type: "GROUP",
        slug,
        participants: {
          create: participantsData
        }
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, name: true, email: true } }
          }
        }
      }
    });

    if (req.io) {
      for (const p of room.participants) {
        req.io.to(p.userId).emit("room-created", { room });
      }
    }

    res.status(201).json({ room });
  } catch (error) {
    console.error("[Rooms] Create error:", error);
    res.status(500).json({ error: "Failed to create room." });
  }
});

/**
 * POST /api/rooms/direct
 * Body: { username }
 * Creates or fetches a DIRECT room with the specified user
 */
router.post("/direct", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Username is required." });

    const targetUser = await prisma.user.findUnique({ where: { username } });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found." });
    }

    if (targetUser.id === req.user.id) {
      return res.status(400).json({ error: "Cannot create a direct message with yourself." });
    }

    // Check if a direct room already exists between these two users
    const existingRooms = await prisma.room.findMany({
      where: {
        type: "DIRECT",
        participants: {
          every: {
            userId: { in: [req.user.id, targetUser.id] }
          }
        }
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, name: true, email: true } }
          }
        }
      }
    });

    // We also need to make sure the room has exactly 2 participants, and they are these two
    const room = existingRooms.find(r => r.participants.length === 2);

    if (room) {
      return res.json({ room });
    }

    // Create a new direct room
    const slug = generateSlug("dm");
    const newRoom = await prisma.room.create({
      data: {
        type: "DIRECT",
        name: "Direct Message",
        slug,
        participants: {
          create: [
            { userId: req.user.id, role: "HOST" },
            { userId: targetUser.id, role: "HOST" }
          ]
        }
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, name: true, email: true } }
          }
        }
      }
    });

    if (req.io) {
      for (const p of newRoom.participants) {
        req.io.to(p.userId).emit("room-created", { room: newRoom });
      }
    }

    res.status(201).json({ room: newRoom });
  } catch (error) {
    console.error("[Rooms] Create DM error:", error);
    res.status(500).json({ error: "Failed to create direct message." });
  }
});

/**
 * GET /api/rooms
 * Returns all rooms the authenticated user is a participant of
 */
router.get("/", async (req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      where: {
        participants: {
          some: { userId: req.user.id }
        }
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, name: true, email: true } }
          }
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            sender: { select: { id: true, name: true, username: true } }
          }
        },
        _count: {
          select: { messages: true }
        }
      },
      orderBy: { updatedAt: "desc" }
    });

    const roomsWithStatus = rooms.map(room => {
      const selfParticipant = room.participants.find(p => p.userId === req.user.id);
      return {
        ...room,
        isPinned: selfParticipant ? selfParticipant.isPinned : false,
        isBlocked: selfParticipant ? selfParticipant.isBlocked : false
      };
    });

    res.json({ rooms: roomsWithStatus });
  } catch (error) {
    console.error("[Rooms] List error:", error);
    res.status(500).json({ error: "Failed to list rooms." });
  }
});

/**
 * GET /api/rooms/:slug
 * Returns a single room by slug
 */
router.get("/:slug", async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, name: true, email: true } }
          }
        }
      }
    });

    if (!room) {
      return res.status(404).json({ error: "Room not found." });
    }

    res.json({ room });
  } catch (error) {
    console.error("[Rooms] Get error:", error);
    res.status(500).json({ error: "Failed to get room." });
  }
});

/**
 * POST /api/rooms/:slug/join
 * Adds the authenticated user to a room as GUEST
 */
router.post("/:slug/join", async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug }
    });

    if (!room) {
      return res.status(404).json({ error: "Room not found." });
    }

    // Check if already a participant
    const existing = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: req.user.id } }
    });

    if (existing) {
      return res.json({ message: "Already a participant.", room });
    }

    await prisma.roomParticipant.create({
      data: {
        roomId: room.id,
        userId: req.user.id,
        role: "GUEST"
      }
    });

    const targetName = req.user.name || `@${req.user.username}`;
    const systemMsg = await prisma.message.create({
      data: {
        roomId: room.id,
        userId: req.user.id,
        body: `${targetName} has joined the group`,
        type: "SYSTEM"
      },
      include: {
        sender: { select: { id: true, name: true, email: true, username: true } }
      }
    });

    if (req.io) {
      req.io.to(room.id).emit("new-message", systemMsg);
    }

    const updatedRoom = await prisma.room.findUnique({
      where: { id: room.id },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, name: true, email: true } }
          }
        }
      }
    });

    res.json({ room: updatedRoom });
  } catch (error) {
    console.error("[Rooms] Join error:", error);
    res.status(500).json({ error: "Failed to join room." });
  }
});

/**
 * POST /api/rooms/:slug/add-member
 * Body: { username }
 * Adds a user to a group room by username
 */
router.post("/:slug/add-member", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Username is required." });

    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug }
    });

    if (!room) {
      return res.status(404).json({ error: "Room not found." });
    }
    
    if (room.type === "DIRECT") {
      return res.status(400).json({ error: "Cannot add members to a direct message." });
    }

    const targetUser = await prisma.user.findUnique({ where: { username } });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found." });
    }

    // Check if already a participant
    const existing = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: targetUser.id } }
    });

    if (existing) {
      return res.status(400).json({ error: "User is already a participant." });
    }

    await prisma.roomParticipant.create({
      data: {
        roomId: room.id,
        userId: targetUser.id,
        role: "GUEST"
      }
    });

    const updatedRoom = await prisma.room.findUnique({
      where: { id: room.id },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, name: true, email: true } }
          }
        }
      }
    });

    const targetName = targetUser.name || `@${targetUser.username}`;
    const systemMsg = await prisma.message.create({
      data: {
        roomId: room.id,
        userId: targetUser.id,
        body: `${targetName} has joined the group`,
        type: "SYSTEM"
      },
      include: {
        sender: { select: { id: true, name: true, email: true, username: true } }
      }
    });

    if (req.io) {
      // Notify the added user directly so their sidebar updates in real-time
      req.io.to(targetUser.id).emit("room-created", { room: updatedRoom });

      // Notify other room members and render the system message
      req.io.to(room.id).emit("new-message", systemMsg);
      req.io.to(room.id).emit("member-added", {
        roomId: room.id,
        userId: targetUser.id,
        username: targetUser.username,
        name: targetName
      });
    }

    res.json({ room: updatedRoom });
  } catch (error) {
    console.error("[Rooms] Add member error:", error);
    res.status(500).json({ error: "Failed to add member." });
  }
});

/**
 * DELETE /api/rooms/:id
 * Deletes a room (Group or DM)
 */
router.delete("/:id", async (req, res) => {
  try {
    const roomId = req.params.id;
    const userId = req.user.id;

    // Check if the room exists
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        participants: true
      }
    });

    if (!room) {
      return res.status(404).json({ error: "Room not found." });
    }

    // Find the current user's participant role in this room
    const participant = room.participants.find(p => p.userId === userId);
    if (!participant) {
      return res.status(403).json({ error: "You are not a participant of this room." });
    }

    // For Group rooms, only the HOST can delete
    // For Direct rooms, both users are hosts, so either can delete
    if (participant.role !== "HOST") {
      return res.status(403).json({ error: "Only the host can delete this room." });
    }

    // Broadcast room-deleted to all connected sockets in this room
    if (req.io) {
      req.io.to(roomId).emit("room-deleted", { roomId });
    }

    // Delete the room. Cascade delete will remove RoomParticipants and Messages.
    await prisma.room.delete({
      where: { id: roomId }
    });

    res.json({ message: "Room deleted successfully." });
  } catch (error) {
    console.error("[Rooms] Delete error:", error);
    res.status(500).json({ error: "Failed to delete room." });
  }
});

/**
 * Generates a URL-safe slug from a room name
 */
function generateSlug(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 40);

  const suffix = Math.random().toString(36).substring(2, 8);
  return `${base}-${suffix}`;
}

/**
 * DELETE /api/rooms/:slug/participants/:userId
 * Removes a participant from a group room.
 * Only the room HOST can remove members.
 */
router.delete("/:slug/participants/:userId", async (req, res) => {
  try {
    const { slug, userId } = req.params;
    const room = await prisma.room.findUnique({
      where: { slug },
      include: { participants: true }
    });
    if (!room) return res.status(404).json({ error: "Room not found." });
    if (room.type === "DIRECT") return res.status(400).json({ error: "Cannot remove members from direct messages." });

    // Check if the requester is the HOST of the room
    const requesterParticipant = room.participants.find(p => p.userId === req.user.id);
    if (!requesterParticipant || requesterParticipant.role !== "HOST") {
      return res.status(403).json({ error: "Only the host can remove members." });
    }

    // Check if the target is in the room
    const targetParticipant = room.participants.find(p => p.userId === userId);
    if (!targetParticipant) {
      return res.status(404).json({ error: "Member not in group." });
    }

    // Host cannot remove themselves
    if (userId === req.user.id) {
      return res.status(400).json({ error: "Host cannot remove themselves." });
    }

    // Fetch user details first
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, name: true }
    });
    const targetName = targetUser ? (targetUser.name || `@${targetUser.username}`) : "A user";

    // Delete participant
    await prisma.roomParticipant.delete({
      where: { roomId_userId: { roomId: room.id, userId } }
    });

    // Create system message
    const systemMsg = await prisma.message.create({
      data: {
        roomId: room.id,
        userId,
        body: `${targetName} was removed from the group`,
        type: "SYSTEM"
      },
      include: {
        sender: { select: { id: true, name: true, email: true, username: true } }
      }
    });

    // Broadcast updates
    if (req.io) {
      req.io.to(room.id).emit("new-message", systemMsg);
      req.io.to(room.id).emit("member-removed", { roomId: room.id, userId, name: targetName, byHost: true });
    }

    res.json({ message: "Member removed successfully." });
  } catch (error) {
    console.error("[Rooms] Remove member error:", error);
    res.status(500).json({ error: "Failed to remove member." });
  }
});

/**
 * POST /api/rooms/:slug/leave
 * Removes the authenticated user from a group room.
 */
router.post("/:slug/leave", async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { slug: req.params.slug },
      include: { participants: true }
    });
    if (!room) return res.status(404).json({ error: "Room not found." });
    if (room.type === "DIRECT") return res.status(400).json({ error: "Cannot leave direct messages." });

    const targetParticipant = room.participants.find(p => p.userId === req.user.id);
    if (!targetParticipant) {
      return res.status(404).json({ error: "You are not a member of this group." });
    }

    if (targetParticipant.role === "HOST") {
      return res.status(400).json({ error: "The host cannot leave the group. You must delete the group instead." });
    }

    // Delete participant
    await prisma.roomParticipant.delete({
      where: { roomId_userId: { roomId: room.id, userId: req.user.id } }
    });

    const targetName = req.user.name || `@${req.user.username}`;
    // Create system message
    const systemMsg = await prisma.message.create({
      data: {
        roomId: room.id,
        userId: req.user.id,
        body: `${targetName} has left the group`,
        type: "SYSTEM"
      },
      include: {
        sender: { select: { id: true, name: true, email: true, username: true } }
      }
    });

    // Broadcast updates
    if (req.io) {
      req.io.to(room.id).emit("new-message", systemMsg);
      req.io.to(room.id).emit("member-removed", { roomId: room.id, userId: req.user.id, name: targetName, byHost: false });
    }

    res.json({ message: "Left group successfully." });
  } catch (error) {
    console.error("[Rooms] Leave room error:", error);
    res.status(500).json({ error: "Failed to leave group." });
  }
});

/**
 * PUT /api/rooms/:id/pin
 * Toggles the pinned status of a room for the authenticated user
 */
router.put("/:id/pin", async (req, res) => {
  try {
    const roomId = req.params.id;
    const userId = req.user.id;

    const participant = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId } }
    });

    if (!participant) {
      return res.status(404).json({ error: "You are not a participant of this room." });
    }

    const updated = await prisma.roomParticipant.update({
      where: { id: participant.id },
      data: { isPinned: !participant.isPinned }
    });

    res.json({ message: updated.isPinned ? "Room pinned." : "Room unpinned.", isPinned: updated.isPinned });
  } catch (error) {
    console.error("[Rooms] Pin error:", error);
    res.status(500).json({ error: "Failed to pin/unpin room." });
  }
});

/**
 * PUT /api/rooms/:id/block
 * Toggles the blocked status of a room for the authenticated user (DIRECT only)
 */
router.put("/:id/block", async (req, res) => {
  try {
    const roomId = req.params.id;
    const userId = req.user.id;

    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: { participants: true }
    });

    if (!room) {
      return res.status(404).json({ error: "Room not found." });
    }

    if (room.type !== "DIRECT") {
      return res.status(400).json({ error: "You can only block direct messages." });
    }

    const participant = room.participants.find(p => p.userId === userId);
    if (!participant) {
      return res.status(404).json({ error: "You are not a participant of this room." });
    }

    const updated = await prisma.roomParticipant.update({
      where: { id: participant.id },
      data: { isBlocked: !participant.isBlocked }
    });

    res.json({ message: updated.isBlocked ? "User blocked." : "User unblocked.", isBlocked: updated.isBlocked });
  } catch (error) {
    console.error("[Rooms] Block error:", error);
    res.status(500).json({ error: "Failed to block/unblock room." });
  }
});

/**
 * DELETE /api/rooms/:id/messages
 * Clears all messages in a room
 */
router.delete("/:id/messages", async (req, res) => {
  try {
    const roomId = req.params.id;
    const userId = req.user.id;

    const participant = await prisma.roomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId } }
    });

    if (!participant) {
      return res.status(404).json({ error: "You are not a participant of this room." });
    }

    await prisma.message.deleteMany({
      where: { roomId }
    });

    if (req.io) {
      req.io.to(roomId).emit("chat-cleared", { roomId });
    }

    res.json({ message: "Chat cleared successfully." });
  } catch (error) {
    console.error("[Rooms] Clear chat error:", error);
    res.status(500).json({ error: "Failed to clear chat." });
  }
});

export default router;
