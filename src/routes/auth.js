import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { authenticateRequest } from "../middleware/auth.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback-dev-secret";
const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = "7d";

/**
 * POST /api/auth/register
 * Body: { name, username, email, password }
 */
router.post("/register", async (req, res) => {
  try {
    const { name, username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    // Check if user or email already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username }
        ]
      }
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(409).json({ error: "An account with this email already exists." });
      } else {
        return res.status(409).json({ error: "This username is already taken." });
      }
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        name: name || null
      }
    });

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    // Store session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.userSession.create({
      data: { userId: user.id, token, expiresAt }
    });

    res.status(201).json({
      token,
      user: { id: user.id, username: user.username, email: user.email, name: user.name }
    });
  } catch (error) {
    console.error("[Auth] Register error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password } 
 * Note: `email` field can contain either email or username from the frontend
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const loginIdentifier = email;

    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: "Username/Email and password are required." });
    }

    // Find user by email or username
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: loginIdentifier },
          { username: loginIdentifier }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    // Store session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.userSession.create({
      data: { userId: user.id, token, expiresAt }
    });

    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, name: user.name }
    });
  } catch (error) {
    console.error("[Auth] Login error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/auth/logout
 * Headers: Authorization: Bearer <token>
 */
router.post("/logout", authenticateRequest, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader.split(" ")[1];

    await prisma.userSession.deleteMany({ where: { token } });

    res.json({ message: "Logged out successfully." });
  } catch (error) {
    console.error("[Auth] Logout error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/auth/me
 * Headers: Authorization: Bearer <token>
 */
router.get("/me", authenticateRequest, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, username: true, email: true, name: true, createdAt: true }
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ user });
  } catch (error) {
    console.error("[Auth] Me error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/auth/search
 * Query parameter: q (search query)
 * Returns closely related users matching query (max 5, excludes self)
 */
router.get("/search", authenticateRequest, async (req, res) => {
  try {
    const q = req.query.q;
    const onlyContacts = req.query.onlyContacts === "true";

    if (!q || typeof q !== "string" || !q.trim()) {
      return res.json({ users: [] });
    }

    let whereClause = {
      username: {
        contains: q.trim(),
        mode: "insensitive"
      },
      id: {
        not: req.user.id
      }
    };

    if (onlyContacts) {
      // Find all DIRECT rooms the user is a participant of
      const dmRooms = await prisma.room.findMany({
        where: {
          type: "DIRECT",
          participants: {
            some: { userId: req.user.id }
          }
        },
        include: {
          participants: true
        }
      });

      // Get the user ID of the other participant in each DM
      const contactUserIds = [];
      dmRooms.forEach(room => {
        const other = room.participants.find(p => p.userId !== req.user.id);
        if (other) {
          contactUserIds.push(other.userId);
        }
      });

      whereClause.id = {
        in: contactUserIds
      };
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      take: 5,
      select: {
        id: true,
        username: true,
        name: true,
        email: true
      }
    });

    res.json({ users });
  } catch (error) {
    console.error("[Auth] Search error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/auth/verify/:username
 * Verifies if user exists in database
 */
router.get("/verify/:username", authenticateRequest, async (req, res) => {
  try {
    const username = req.params.username;
    if (!username) {
      return res.status(400).json({ error: "Username is required." });
    }

    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ exists: true, user: { id: user.id, username: user.username, name: user.name } });
  } catch (error) {
    console.error("[Auth] Verify error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * PUT /api/auth/profile
 * Headers: Authorization: Bearer <token>
 * Body: { name, username, email }
 */
router.put("/profile", authenticateRequest, async (req, res) => {
  try {
    const { name, username, email } = req.body;
    const userId = req.user.id;

    if (!username || !email) {
      return res.status(400).json({ error: "Username and email are required." });
    }

    // Check if new username or email is already taken by a different user
    const existingUser = await prisma.user.findFirst({
      where: {
        AND: [
          { id: { not: userId } },
          {
            OR: [
              { email },
              { username }
            ]
          }
        ]
      }
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(409).json({ error: "An account with this email already exists." });
      } else {
        return res.status(409).json({ error: "This username is already taken." });
      }
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name: name || null,
        username,
        email
      }
    });

    // Generate a new token
    const token = jwt.sign(
      { id: updatedUser.id, username: updatedUser.username, email: updatedUser.email, name: updatedUser.name },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    // Store new session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.userSession.create({
      data: { userId: updatedUser.id, token, expiresAt }
    });

    res.json({
      token,
      user: { id: updatedUser.id, username: updatedUser.username, email: updatedUser.email, name: updatedUser.name }
    });
  } catch (error) {
    console.error("[Auth] Profile update error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * PUT /api/auth/profile/password
 * Headers: Authorization: Bearer <token>
 * Body: { currentPassword, newPassword }
 */
router.put("/profile/password", authenticateRequest, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    // Fetch user
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    // Verify current password
    const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    // Hash new password and update user
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    });

    res.json({ message: "Password updated successfully." });
  } catch (error) {
    console.error("[Auth] Password update error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/auth/contacts
 * Returns list of all DM contacts (users you share a DIRECT room with)
 */
router.get("/contacts", authenticateRequest, async (req, res) => {
  try {
    const dmRooms = await prisma.room.findMany({
      where: {
        type: "DIRECT",
        participants: {
          some: { userId: req.user.id }
        }
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                name: true,
                email: true
              }
            }
          }
        }
      }
    });

    const contacts = [];
    dmRooms.forEach(room => {
      const other = room.participants.find(p => p.userId !== req.user.id);
      if (other && other.user) {
        contacts.push({
          ...other.user,
          roomId: room.id
        });
      }
    });

    res.json({ contacts });
  } catch (error) {
    console.error("[Auth] Get contacts error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * DELETE /api/auth/profile
 * Headers: Authorization: Bearer <token>
 */
router.delete("/profile", authenticateRequest, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Delete user from DB. Prisma cascades deletions for related tables.
    await prisma.user.delete({ where: { id: userId } });
    
    res.json({ message: "Account deleted successfully." });
  } catch (error) {
    console.error("[Auth] Account delete error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/auth/contacts/rename
 * Headers: Authorization: Bearer <token>
 * Body: { contactId, customName }
 */
router.post("/contacts/rename", authenticateRequest, async (req, res) => {
  try {
    const { contactId, customName } = req.body;
    if (!contactId) {
      return res.status(400).json({ error: "Contact ID is required." });
    }

    const value = customName && customName.trim() ? customName.trim() : null;

    // Check if the contact exists
    const contactUser = await prisma.user.findUnique({
      where: { id: contactId }
    });
    if (!contactUser) {
      return res.status(404).json({ error: "User not found." });
    }

    // Upsert a ContactLink
    await prisma.contactLink.upsert({
      where: {
        userId_contactId: {
          userId: req.user.id,
          contactId
        }
      },
      update: {
        customName: value
      },
      create: {
        userId: req.user.id,
        contactId,
        customName: value
      }
    });

    res.json({ message: "Contact renamed successfully." });
  } catch (error) {
    console.error("[Auth] Rename contact error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

export default router;

