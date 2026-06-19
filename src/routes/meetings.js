import { Router } from "express";
import { prisma } from "../db.js";
import { authenticateRequest } from "../middleware/auth.js";

const router = Router();

router.use(authenticateRequest);

/**
 * POST /api/meetings
 * Body: { title, usernames: string[] }
 * Creates a meeting, generates a unique code, saves invites,
 * and emits socket notifications to invitees.
 */
router.post("/", async (req, res) => {
  try {
    const { title, usernames } = req.body;
    const hostId = req.user.id;

    // Generate a unique meeting code (e.g. "meet-abc123")
    const code = "meet-" + Math.random().toString(36).substring(2, 9);

    const meeting = await prisma.meeting.create({
      data: {
        hostId,
        title: title || "Untitled Meeting",
        code
      }
    });

    // Create invites for each username
    let invitedUsers = [];
    if (usernames && Array.isArray(usernames) && usernames.length > 0) {
      const users = await prisma.user.findMany({
        where: { username: { in: usernames }, id: { not: hostId } },
        select: { id: true, username: true, name: true }
      });

      if (users.length > 0) {
        await prisma.meetingInvite.createMany({
          data: users.map(u => ({
            meetingId: meeting.id,
            userId: u.id
          }))
        });
        invitedUsers = users;
      }
    }

    // Emit real-time notifications to each invited user via their personal socket room
    if (req.io && invitedUsers.length > 0) {
      const hostUser = await prisma.user.findUnique({
        where: { id: hostId },
        select: { name: true, username: true }
      });

      for (const u of invitedUsers) {
        req.io.to(u.id).emit("meeting-invite", {
          meetingId: meeting.id,
          meetingCode: meeting.code,
          title: meeting.title,
          hostName: hostUser?.name || hostUser?.username || "Someone",
          hostId
        });
      }
    }

    res.status(201).json({
      meeting: {
        id: meeting.id,
        code: meeting.code,
        title: meeting.title,
        invitedCount: invitedUsers.length
      }
    });
  } catch (error) {
    console.error("[Meetings] Create error:", error);
    res.status(500).json({ error: "Failed to create meeting." });
  }
});

/**
 * GET /api/meetings/invites
 * Returns the current user's meeting invites (either unseen or where the meeting is still active).
 */
router.get("/invites", async (req, res) => {
  try {
    const invites = await prisma.meetingInvite.findMany({
      where: { userId: req.user.id, seen: false },
      include: {
        meeting: {
          include: {
            host: { select: { id: true, name: true, username: true } }
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ invites });
  } catch (error) {
    console.error("[Meetings] Get invites error:", error);
    res.status(500).json({ error: "Failed to get invites." });
  }
});

/**
 * PUT /api/meetings/invites/seen-all
 * Marks all invites for the current user as seen.
 */
router.put("/invites/seen-all", async (req, res) => {
  try {
    await prisma.meetingInvite.updateMany({
      where: { userId: req.user.id, seen: false },
      data: { seen: true }
    });
    res.json({ message: "All invites marked as seen." });
  } catch (error) {
    console.error("[Meetings] Mark all seen error:", error);
    res.status(500).json({ error: "Failed to mark all invites as seen." });
  }
});

/**
 * PUT /api/meetings/invites/:id/seen
 * Marks an invite as seen.
 */
router.put("/invites/:id/seen", async (req, res) => {
  try {
    await prisma.meetingInvite.update({
      where: { id: req.params.id },
      data: { seen: true }
    });
    res.json({ message: "Invite marked as seen." });
  } catch (error) {
    console.error("[Meetings] Mark seen error:", error);
    res.status(500).json({ error: "Failed to mark invite." });
  }
});

/**
 * GET /api/meetings/:code
 * Returns meeting details by code.
 */
router.get("/:code", async (req, res) => {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { code: req.params.code },
      include: {
        host: { select: { id: true, name: true, username: true } },
        invites: {
          include: {
            user: { select: { id: true, name: true, username: true } }
          }
        }
      }
    });

    if (!meeting) {
      return res.status(404).json({ error: "Meeting not found." });
    }

    if (!meeting.isActive) {
      return res.status(400).json({ error: "This meeting has already ended." });
    }

    // Mark invite as seen since the user has joined the meeting
    await prisma.meetingInvite.updateMany({
      where: {
        meetingId: meeting.id,
        userId: req.user.id,
        seen: false
      },
      data: { seen: true }
    });

    res.json({ meeting });
  } catch (error) {
    console.error("[Meetings] Get error:", error);
    res.status(500).json({ error: "Failed to get meeting." });
  }
});

/**
 * DELETE /api/meetings/:id
 * End/delete a meeting. Host only. Sets isActive to false (soft delete).
 */
router.delete("/:id", async (req, res) => {
  try {
    const meeting = await prisma.meeting.findUnique({ where: { id: req.params.id } });
    if (!meeting) {
      return res.status(404).json({ error: "Meeting not found." });
    }
    if (meeting.hostId !== req.user.id) {
      return res.status(403).json({ error: "Only the host can end this meeting." });
    }

    // Broadcast meeting ended to active participants
    if (req.io) {
      req.io.to(`meeting:${meeting.code}`).emit("meeting-ended", { meetingCode: meeting.code });
    }

    // Find all pending invites and notify them
    const pendingInvites = await prisma.meetingInvite.findMany({
      where: { meetingId: meeting.id, seen: false }
    });

    if (req.io && pendingInvites.length > 0) {
      pendingInvites.forEach(invite => {
        req.io.to(invite.userId).emit("meeting-ended-update", {
          meetingId: meeting.id,
          meetingCode: meeting.code
        });
      });
    }

    await prisma.meeting.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });

    res.json({ message: "Meeting ended." });
  } catch (error) {
    console.error("[Meetings] Delete error:", error);
    res.status(500).json({ error: "Failed to end meeting." });
  }
});

/**
 * POST /api/meetings/:code/invite
 * Body: { username }
 * Invites a user to an existing meeting by username and emits socket notifications.
 */
router.post("/:code/invite", async (req, res) => {
  try {
    const { username } = req.body;
    const meetingCode = req.params.code;

    if (!username) return res.status(400).json({ error: "Username is required." });

    const meeting = await prisma.meeting.findUnique({
      where: { code: meetingCode }
    });

    if (!meeting) {
      return res.status(404).json({ error: "Meeting not found." });
    }

    const targetUser = await prisma.user.findUnique({
      where: { username }
    });

    if (!targetUser) {
      return res.status(404).json({ error: "User not found." });
    }

    // Create or update invite (reset seen to false if invited again)
    await prisma.meetingInvite.upsert({
      where: {
        meetingId_userId: {
          meetingId: meeting.id,
          userId: targetUser.id
        }
      },
      update: { seen: false },
      create: {
        meetingId: meeting.id,
        userId: targetUser.id,
        seen: false
      }
    });

    // Emit real-time notification to the invited user's personal room
    if (req.io) {
      const hostUser = await prisma.user.findUnique({
        where: { id: meeting.hostId },
        select: { name: true, username: true }
      });

      req.io.to(targetUser.id).emit("meeting-invite", {
        meetingId: meeting.id,
        meetingCode: meeting.code,
        title: meeting.title,
        hostName: hostUser?.name || hostUser?.username || "Someone",
        hostId: meeting.hostId
      });
    }

    res.json({ message: "User invited successfully." });
  } catch (error) {
    console.error("[Meetings] Invite error:", error);
    res.status(500).json({ error: "Failed to invite user." });
  }
});

export default router;
