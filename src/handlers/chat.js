import { prisma } from "../db.js";

const meetingWhiteboards = {}; // meetingCode -> { paths: [] }
const meetingAnnotations = {}; // meetingCode -> { paths: [] }

/**
 * Registers Socket.io event handlers for real-time chat.
 * Called once per socket connection after JWT authentication.
 */
export function registerChatHandlers(io, socket) {

  // Join personal room for targeted notifications (meetings, etc.)
  socket.join(socket.userId);

  const checkAndEndMeeting = async (meetingCode, userId) => {
    try {
      const meeting = await prisma.meeting.findUnique({
        where: { code: meetingCode }
      });
      if (meeting && meeting.isActive && meeting.hostId === userId) {
        console.log(`[Socket] Host ${userId} leaving/disconnecting. Ending meeting ${meetingCode}.`);
        
        await prisma.meeting.update({
          where: { id: meeting.id },
          data: { isActive: false }
        });

        const meetingRoom = `meeting:${meetingCode}`;
        io.to(meetingRoom).emit("meeting-ended", { meetingCode });

        // Notify all invitees who have not seen/joined yet
        const invites = await prisma.meetingInvite.findMany({
          where: { meetingId: meeting.id, seen: false }
        });

        invites.forEach(invite => {
          io.to(invite.userId).emit("meeting-ended-update", {
            meetingId: meeting.id,
            meetingCode: meeting.code
          });
        });
      }
    } catch (error) {
      console.error("[Socket] Error ending meeting on host exit:", error);
    }
  };

  /**
   * join-room — Client joins a chat room.
   * Validates membership, joins Socket.io room, sends message history.
   */
  socket.on("join-room", async ({ roomId }) => {
    try {
      const userId = socket.userId;

      // Validate that user is a participant
      const participant = await prisma.roomParticipant.findUnique({
        where: { roomId_userId: { roomId, userId } }
      });

      if (!participant) {
        socket.emit("error", { message: "You are not a participant of this room." });
        return;
      }

      // Join the Socket.io room
      socket.join(roomId);
      socket.currentRoomId = roomId;

      console.log(`[Chat] ${socket.userName} joined room ${roomId}`);

      // Retrieve last 50 messages with parent for replies
      const history = await prisma.message.findMany({
        where: { roomId },
        orderBy: { createdAt: "asc" },
        take: 50,
        include: {
          sender: {
            select: { id: true, name: true, email: true, username: true }
          },
          parent: {
            include: {
              sender: {
                select: { id: true, name: true, email: true, username: true }
              }
            }
          }
        }
      });

      // Send history to the joining client only
      socket.emit("room-history", history);

      // Notify others in the room
      socket.to(roomId).emit("user-joined", {
        userId,
        name: socket.userName,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error("[Chat] join-room error:", error);
      socket.emit("error", { message: "Failed to join room." });
    }
  });

  /**
   * send-message — Persists message and broadcasts to room.
   * Supports optional parentId for replies.
   */
  socket.on("send-message", async ({ roomId, body, parentId, type, fileUrl, fileName, fileMimeType, fileSizeBytes }) => {
    try {
      const userId = socket.userId;

      // Check if direct room is blocked by any participant
      const blockedParticipant = await prisma.roomParticipant.findFirst({
        where: { roomId, isBlocked: true }
      });
      if (blockedParticipant) {
        socket.emit("error", { message: "This chat has been blocked." });
        return;
      }

      // For file/voice/image messages, body can be empty but fileUrl must exist
      const msgType = type || "TEXT";
      if (msgType === "TEXT" && (!body || !body.trim())) return;
      if (msgType !== "TEXT" && !fileUrl) return;

      const message = await prisma.message.create({
        data: {
          roomId,
          userId,
          body: (body || "").trim(),
          type: msgType,
          parentId: parentId || null,
          fileUrl: fileUrl || null,
          fileName: fileName || null,
          fileMimeType: fileMimeType || null,
          fileSizeBytes: fileSizeBytes || null
        },
        include: {
          sender: {
            select: { id: true, name: true, email: true, username: true }
          },
          parent: {
            include: {
              sender: {
                select: { id: true, name: true, email: true, username: true }
              }
            }
          }
        }
      });

      // Broadcast to ALL sockets in the room (including sender)
      io.to(roomId).emit("new-message", message);

      // Fetch other participants to emit message-notification
      const otherParticipants = await prisma.roomParticipant.findMany({
        where: { roomId, userId: { not: userId } },
        select: { userId: true }
      });

      const senderName = message.sender.name || `@${message.sender.username}`;
      const notifBody = msgType === "TEXT" ? message.body : (msgType === "VOICE" ? "Voice message" : `File: ${fileName || "Attachment"}`);
      for (const p of otherParticipants) {
        io.to(p.userId).emit("message-notification", {
          roomId,
          senderName,
          body: notifBody,
          senderId: userId
        });
      }

      // Update room's updatedAt timestamp
      await prisma.room.update({
        where: { id: roomId },
        data: { updatedAt: new Date() }
      });

    } catch (error) {
      console.error("[Chat] send-message error:", error);
      socket.emit("error", { message: "Failed to send message." });
    }
  });

  /**
   * edit-message — Edits a message. Only the sender can edit their own messages.
   */
  socket.on("edit-message", async ({ messageId, body }) => {
    try {
      if (!body || !body.trim()) return;

      // Fetch the message and verify ownership
      const message = await prisma.message.findUnique({ where: { id: messageId } });
      if (!message || message.userId !== socket.userId) {
        socket.emit("error", { message: "Cannot edit this message." });
        return;
      }

      const updated = await prisma.message.update({
        where: { id: messageId },
        data: { body: body.trim(), isEdited: true },
        include: {
          sender: {
            select: { id: true, name: true, email: true, username: true }
          }
        }
      });

      // Broadcast to all sockets in the room
      io.to(message.roomId).emit("message-edited", {
        id: updated.id,
        body: updated.body,
        isEdited: updated.isEdited
      });

    } catch (error) {
      console.error("[Chat] edit-message error:", error);
      socket.emit("error", { message: "Failed to edit message." });
    }
  });

  /**
   * delete-message — Deletes a message. Only the sender can delete their own messages.
   */
  socket.on("delete-message", async ({ messageId }) => {
    try {
      const message = await prisma.message.findUnique({ where: { id: messageId } });
      if (!message || message.userId !== socket.userId) {
        socket.emit("error", { message: "Cannot delete this message." });
        return;
      }

      await prisma.message.delete({ where: { id: messageId } });

      // Broadcast to all sockets in the room
      io.to(message.roomId).emit("message-deleted", { id: messageId });

    } catch (error) {
      console.error("[Chat] delete-message error:", error);
      socket.emit("error", { message: "Failed to delete message." });
    }
  });

  /**
   * typing — Broadcasts typing indicator to room (not persisted).
   */
  socket.on("typing", ({ roomId }) => {
    socket.to(roomId).emit("user-typing", {
      userId: socket.userId,
      name: socket.userName
    });
  });

  /**
   * stop-typing — Clears typing indicator.
   */
  socket.on("stop-typing", ({ roomId }) => {
    socket.to(roomId).emit("user-stop-typing", {
      userId: socket.userId
    });
  });

  /**
   * leave-room — Client leaves a chat room.
   */
  socket.on("leave-room", ({ roomId }) => {
    socket.leave(roomId);
    socket.currentRoomId = null;

    socket.to(roomId).emit("user-left", {
      userId: socket.userId,
      name: socket.userName,
      timestamp: new Date().toISOString()
    });

    console.log(`[Chat] ${socket.userName} left room ${roomId}`);
  });

  /**
   * On disconnect — notify any active room.
   */
  socket.on("disconnect", async () => {
    if (socket.currentRoomId) {
      socket.to(socket.currentRoomId).emit("user-left", {
        userId: socket.userId,
        name: socket.userName,
        timestamp: new Date().toISOString()
      });
      // Also notify call participants
      socket.to(socket.currentRoomId).emit("user-left-call", {
        userId: socket.userId,
        socketId: socket.id
      });
    }
    if (socket.currentAudioRoom) {
      socket.to(socket.currentAudioRoom).emit("audio-user-left", {
        userId: socket.userId,
        socketId: socket.id
      });
    }
    if (socket.currentMeetingRoom) {
      const meetingRoom = socket.currentMeetingRoom;
      const meetingCode = meetingRoom.split(":")[1];

      await checkAndEndMeeting(meetingCode, socket.userId);

      socket.to(meetingRoom).emit("meeting-user-left", {
        userId: socket.userId,
        socketId: socket.id
      });
      setTimeout(() => {
        const clients = io.sockets.adapter.rooms.get(meetingRoom);
        if (!clients || clients.size === 0) {
          delete meetingWhiteboards[meetingCode];
          delete meetingAnnotations[meetingCode];
          console.log(`[Socket] Cleaned up whiteboard cache for empty meeting room ${meetingCode}`);
        }
      }, 500);
    }
  });

  // --- WEBRTC SIGNALING (in-chat calls) ---

  socket.on("join-call", ({ roomId }) => {
    socket.to(roomId).emit("user-joined-call", {
      userId: socket.userId,
      socketId: socket.id,
      name: socket.userName
    });
  });

  socket.on("leave-call", ({ roomId }) => {
    socket.to(roomId).emit("user-left-call", {
      userId: socket.userId,
      socketId: socket.id
    });
  });

  socket.on("webrtc-offer", ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit("webrtc-offer", {
      fromSocketId: socket.id,
      fromUserId: socket.userId,
      offer
    });
  });

  socket.on("webrtc-answer", ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit("webrtc-answer", {
      fromSocketId: socket.id,
      answer
    });
  });

  socket.on("webrtc-ice-candidate", ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit("webrtc-ice-candidate", {
      fromSocketId: socket.id,
      candidate
    });
  });

  // --- AUDIO CALL SIGNALING ---

  socket.on("request-audio-call", async ({ roomId, roomName, isGroupCall }) => {
    try {
      const participants = await prisma.roomParticipant.findMany({
        where: { roomId, userId: { not: socket.userId } },
        select: { userId: true }
      });

      for (const p of participants) {
        io.to(p.userId).emit("incoming-audio-call", {
          roomId,
          roomName: roomName || "Audio Call",
          isGroupCall,
          callerName: socket.userName,
          callerId: socket.userId
        });
      }
    } catch (err) {
      console.error("[Socket] request-audio-call error:", err);
    }
  });

  socket.on("join-audio-call", ({ roomId }) => {
    const audioRoom = `audio:${roomId}`;
    socket.join(audioRoom);
    socket.currentAudioRoom = audioRoom;

    socket.to(audioRoom).emit("audio-user-joined", {
      userId: socket.userId,
      socketId: socket.id,
      name: socket.userName
    });
  });

  socket.on("leave-audio-call", ({ roomId }) => {
    const audioRoom = `audio:${roomId}`;
    socket.to(audioRoom).emit("audio-user-left", {
      userId: socket.userId,
      socketId: socket.id
    });
    socket.leave(audioRoom);
    if (socket.currentAudioRoom === audioRoom) {
      socket.currentAudioRoom = null;
    }
  });

  socket.on("audio-offer", ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit("audio-offer", {
      fromSocketId: socket.id,
      fromUserId: socket.userId,
      name: socket.userName,
      offer
    });
  });

  socket.on("audio-answer", ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit("audio-answer", {
      fromSocketId: socket.id,
      answer
    });
  });

  socket.on("audio-ice-candidate", ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit("audio-ice-candidate", {
      fromSocketId: socket.id,
      candidate
    });
  });

  // --- MEETING SIGNALING ---

  socket.on("join-meeting", ({ meetingCode }) => {
    const meetingRoom = `meeting:${meetingCode}`;
    socket.join(meetingRoom);
    socket.currentMeetingRoom = meetingRoom;

    socket.to(meetingRoom).emit("meeting-user-joined", {
      userId: socket.userId,
      socketId: socket.id,
      name: socket.userName
    });

    // Send initial whiteboard and screen share annotations history to this socket
    const wb = meetingWhiteboards[meetingCode] || {};
    const ann = meetingAnnotations[meetingCode] || { paths: [] };
    socket.emit("whiteboard-init", { whiteboards: wb });
    socket.emit("annotation-init", { paths: ann.paths });
  });

  socket.on("meeting-toggle-media", ({ meetingCode, video, audio }) => {
    const meetingRoom = `meeting:${meetingCode}`;
    socket.to(meetingRoom).emit("meeting-user-media-toggled", {
      socketId: socket.id,
      video,
      audio
    });
  });

  socket.on("meeting-toggle-whiteboard", ({ meetingCode, active }) => {
    const meetingRoom = `meeting:${meetingCode}`;
    socket.to(meetingRoom).emit("meeting-whiteboard-toggled", {
      presenterId: socket.id,
      active
    });
  });

  socket.on("leave-meeting", async ({ meetingCode }) => {
    await checkAndEndMeeting(meetingCode, socket.userId);

    const meetingRoom = `meeting:${meetingCode}`;
    socket.to(meetingRoom).emit("meeting-user-left", {
      userId: socket.userId,
      socketId: socket.id
    });
    socket.leave(meetingRoom);
    socket.currentMeetingRoom = null;

    // Check if room is empty to delete caches
    const clients = io.sockets.adapter.rooms.get(meetingRoom);
    if (!clients || clients.size === 0) {
      delete meetingWhiteboards[meetingCode];
      delete meetingAnnotations[meetingCode];
      console.log(`[Socket] Cleaned up whiteboard cache for empty meeting room ${meetingCode}`);
    }
  });

  // --- WHITEBOARD & SCREEN ANNOTATION EVENTS ---

  socket.on("wb-draw", ({ meetingCode, path }) => {
    const pid = socket.id;
    if (!meetingWhiteboards[meetingCode]) {
      meetingWhiteboards[meetingCode] = {};
    }
    if (!meetingWhiteboards[meetingCode][pid]) {
      meetingWhiteboards[meetingCode][pid] = { paths: [] };
    }
    meetingWhiteboards[meetingCode][pid].paths.push(path);
    socket.to(`meeting:${meetingCode}`).emit("wb-draw", { presenterId: pid, path });
  });

  socket.on("wb-move", ({ meetingCode, elementId, dx, dy }) => {
    const pid = socket.id;
    const roomWb = meetingWhiteboards[meetingCode];
    if (roomWb && roomWb[pid]) {
      const el = roomWb[pid].paths.find(p => p.id === elementId);
      if (el) {
        if (el.type === "pen" || el.type === "eraser") {
          el.points.forEach(pt => {
            pt.x += dx;
            pt.y += dy;
          });
        } else if (el.type === "line" || el.type === "rect" || el.type === "circle") {
          el.start.x += dx;
          el.start.y += dy;
          el.end.x += dx;
          el.end.y += dy;
        } else if (el.type === "text") {
          el.x += dx;
          el.y += dy;
        }
      }
      socket.to(`meeting:${meetingCode}`).emit("wb-move", { presenterId: pid, elementId, dx, dy });
    }
  });

  socket.on("wb-delete", ({ meetingCode, elementId }) => {
    const pid = socket.id;
    const roomWb = meetingWhiteboards[meetingCode];
    if (roomWb && roomWb[pid]) {
      roomWb[pid].paths = roomWb[pid].paths.filter(p => p.id !== elementId);
      socket.to(`meeting:${meetingCode}`).emit("wb-delete", { presenterId: pid, elementId });
    }
  });

  socket.on("wb-undo", ({ meetingCode, elementId }) => {
    const pid = socket.id;
    const roomWb = meetingWhiteboards[meetingCode];
    if (roomWb && roomWb[pid]) {
      roomWb[pid].paths = roomWb[pid].paths.filter(p => p.id !== elementId);
      socket.to(`meeting:${meetingCode}`).emit("wb-undo", { presenterId: pid, elementId });
    }
  });

  socket.on("wb-redo", ({ meetingCode, path }) => {
    const pid = socket.id;
    if (!meetingWhiteboards[meetingCode]) {
      meetingWhiteboards[meetingCode] = {};
    }
    if (!meetingWhiteboards[meetingCode][pid]) {
      meetingWhiteboards[meetingCode][pid] = { paths: [] };
    }
    meetingWhiteboards[meetingCode][pid].paths.push(path);
    socket.to(`meeting:${meetingCode}`).emit("wb-redo", { presenterId: pid, path });
  });

  socket.on("wb-clear", ({ meetingCode }) => {
    const pid = socket.id;
    const roomWb = meetingWhiteboards[meetingCode];
    if (roomWb && roomWb[pid]) {
      roomWb[pid].paths = [];
    }
    socket.to(`meeting:${meetingCode}`).emit("wb-clear", { presenterId: pid });
  });

  socket.on("ann-draw", ({ meetingCode, path }) => {
    if (!meetingAnnotations[meetingCode]) {
      meetingAnnotations[meetingCode] = { paths: [] };
    }
    meetingAnnotations[meetingCode].paths.push(path);
    socket.to(`meeting:${meetingCode}`).emit("ann-draw", { path });
  });

  socket.on("ann-undo", ({ meetingCode, elementId }) => {
    const ann = meetingAnnotations[meetingCode];
    if (ann) {
      ann.paths = ann.paths.filter(p => p.id !== elementId);
      socket.to(`meeting:${meetingCode}`).emit("ann-undo", { elementId });
    }
  });

  socket.on("ann-clear", ({ meetingCode }) => {
    if (meetingAnnotations[meetingCode]) {
      meetingAnnotations[meetingCode].paths = [];
    }
    socket.to(`meeting:${meetingCode}`).emit("ann-clear");
  });

  socket.on("meeting-offer", ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit("meeting-offer", {
      fromSocketId: socket.id,
      fromUserId: socket.userId,
      name: socket.userName,
      offer
    });
  });

  socket.on("meeting-answer", ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit("meeting-answer", {
      fromSocketId: socket.id,
      answer
    });
  });

  socket.on("meeting-ice-candidate", ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit("meeting-ice-candidate", {
      fromSocketId: socket.id,
      candidate
    });
  });

  socket.on("kick-participant", async ({ meetingCode, targetSocketId }) => {
    try {
      const meeting = await prisma.meeting.findUnique({
        where: { code: meetingCode }
      });
      if (!meeting || meeting.hostId !== socket.userId) {
        socket.emit("error", { message: "Only the host can kick participants." });
        return;
      }

      io.to(targetSocketId).emit("meeting-kicked", { meetingCode });
    } catch (error) {
      console.error("[Meeting] Kick error:", error);
    }
  });

  socket.on("end-meeting", ({ meetingCode }) => {
    const meetingRoom = `meeting:${meetingCode}`;
    io.to(meetingRoom).emit("meeting-ended", { meetingCode });
  });
}
