import { Router } from "express";
import { authenticateRequest } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";

const router = Router();

router.use(authenticateRequest);

/**
 * POST /api/files/upload
 * Upload a single file. Returns file metadata.
 */
router.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const sizeBytes = req.file.size;

    res.status(201).json({
      url: fileUrl,
      fileName,
      mimeType,
      sizeBytes
    });
  } catch (error) {
    console.error("[Files] Upload error:", error);
    res.status(500).json({ error: "Failed to upload file." });
  }
});

/**
 * POST /api/files/whiteboard
 * Upload a whiteboard PNG image from base64 data.
 * Body: { imageData } (base64 data URL)
 */
router.post("/whiteboard", async (req, res) => {
  try {
    const { imageData } = req.body;
    if (!imageData) {
      return res.status(400).json({ error: "No image data provided." });
    }

    const matches = imageData.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: "Invalid image data format." });
    }

    const ext = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, "base64");

    const { randomUUID } = await import("node:crypto");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const uploadsDir = path.join(__dirname, "../../public/uploads");

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filename = `whiteboard-${randomUUID()}.${ext}`;
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, buffer);

    res.status(201).json({
      url: `/uploads/${filename}`,
      fileName: `whiteboard.${ext}`,
      mimeType: `image/${ext}`,
      sizeBytes: buffer.length
    });
  } catch (error) {
    console.error("[Files] Whiteboard upload error:", error);
    res.status(500).json({ error: "Failed to upload whiteboard image." });
  }
});

export default router;
