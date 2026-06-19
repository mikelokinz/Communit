/**
 * chat.js — Client-side chat logic
 * Handles joining rooms, sending/editing/deleting/replying messages,
 * rendering chat bubbles (self right, others left), typing indicators,
 * file attachments, and voice messages.
 */

import { getSocket } from "./socket.js";
import { getCurrentUser, getUserInitials, authFetch, getDisplayName } from "./auth.js";

let currentSocket = null;
let currentRoomId = null;
let currentRoomType = null;
let typingTimeout = null;

// Reply state
let replyToMessage = null;

// Voice recording state
let mediaRecorder = null;
let voiceChunks = [];
let voiceRecordingTimer = null;
let voiceRecordingSeconds = 0;

function resolveMessageNames(msg) {
  if (!msg) return msg;
  try {
    const currentUser = getCurrentUser();
    if (msg.sender && msg.sender.id !== currentUser?.id) {
      msg.sender.name = getDisplayName(msg.sender.id, msg.sender.name || msg.sender.username);
    }
    if (msg.parent && msg.parent.sender && msg.parent.sender.id !== currentUser?.id) {
      msg.parent.sender.name = getDisplayName(msg.parent.sender.id, msg.parent.sender.name || msg.parent.sender.username);
    }
  } catch (e) {}
  return msg;
}

/**
 * Initialize chat for a given room ID.
 */
export async function initChat(roomId, roomType) {
  currentRoomId = roomId;
  currentRoomType = roomType;
  currentSocket = await getSocket();

  // Join the room
  currentSocket.emit("join-room", { roomId });

  // Listen for message history
  currentSocket.on("room-history", (messages) => {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    container.innerHTML = "";
    messages.forEach(msg => renderMessage(resolveMessageNames(msg)));
    scrollToBottom();
  });

  // Listen for new messages
  currentSocket.on("new-message", (message) => {
    renderMessage(resolveMessageNames(message));
    scrollToBottom();
  });

  // Listen for message edited
  currentSocket.on("message-edited", ({ id, body, isEdited }) => {
    const bodyEl = document.querySelector(`[data-msg-id="${id}"] .message-body`);
    if (bodyEl) {
      bodyEl.innerHTML = escapeHtml(body);
      // Add (edited) tag if not already present
      if (isEdited) {
        let editTag = document.querySelector(`[data-msg-id="${id}"] .message-edited-tag`);
        if (!editTag) {
          editTag = document.createElement("span");
          editTag.className = "message-edited-tag";
          editTag.textContent = "(edited)";
          bodyEl.appendChild(editTag);
        }
      }
    }
  });

  // Listen for message deleted
  currentSocket.on("message-deleted", ({ id }) => {
    const msgEl = document.querySelector(`[data-msg-id="${id}"]`);
    if (msgEl) {
      msgEl.style.animation = "fadeInUp 0.2s ease reverse";
      setTimeout(() => msgEl.remove(), 200);
    }
    // If we were replying to the deleted message, clear reply
    if (replyToMessage && replyToMessage.id === id) {
      clearReply();
    }
  });

  // Listen for typing indicators
  currentSocket.on("user-typing", ({ userId, name }) => {
    const indicator = document.getElementById("typing-indicator");
    if (indicator) indicator.textContent = `${getDisplayName(userId, name)} is typing...`;
  });

  currentSocket.on("user-stop-typing", () => {
    const indicator = document.getElementById("typing-indicator");
    if (indicator) indicator.textContent = "";
  });

  // Listen for user join/leave events
  currentSocket.on("user-joined", ({ userId, name }) => {
    renderSystemMessage(`${getDisplayName(userId, name)} is in the chat`);
    scrollToBottom();
  });

  currentSocket.on("user-left", ({ userId, name }) => {
    renderSystemMessage(`${getDisplayName(userId, name)} has left the chat`);
    scrollToBottom();
  });

  // Listen for room deletion
  currentSocket.on("room-deleted", ({ roomId }) => {
    if (currentRoomId === roomId) {
      alert("This room has been deleted by the host.");
      window.location.href = "/dashboard.html";
    }
  });

  // Listen for member addition
  currentSocket.on("member-added", ({ roomId }) => {
    if (currentRoomId === roomId) {
      document.dispatchEvent(new CustomEvent("room-participants-changed", { detail: { roomId } }));
    }
  });

  // Listen for member removal
  currentSocket.on("member-removed", ({ roomId, userId, name, byHost }) => {
    if (currentRoomId === roomId) {
      const currentUser = getCurrentUser();
      if (currentUser && currentUser.id === userId) {
        alert(byHost ? "You have been removed from this group by the host." : "You have left this group.");
        window.location.href = "/dashboard.html";
      } else {
        document.dispatchEvent(new CustomEvent("room-participants-changed", { detail: { roomId } }));
      }
    }
  });

  // Listen for chat clear
  currentSocket.on("chat-cleared", ({ roomId }) => {
    if (currentRoomId === roomId) {
      const container = document.getElementById("chat-messages");
      if (container) container.innerHTML = "";
    }
  });

  // Set up input handlers
  setupInputHandlers();
  setupReplyHandlers();
  setupFileHandlers();
  setupVoiceRecordingHandlers();
}

/**
 * Send a text message to the current room.
 */
export function sendMessage(body) {
  if (!currentSocket || !currentRoomId || !body.trim()) return;

  const data = { roomId: currentRoomId, body: body.trim(), type: "TEXT" };
  if (replyToMessage) {
    data.parentId = replyToMessage.id;
  }

  currentSocket.emit("send-message", data);
  currentSocket.emit("stop-typing", { roomId: currentRoomId });

  // Clear reply state
  clearReply();
}

/**
 * Send a file message.
 */
export async function sendFileMessage(file) {
  if (!currentSocket || !currentRoomId || !file) return;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const token = localStorage.getItem("communit_token");
    const res = await fetch("/api/files/upload", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
      body: formData
    });

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || "Failed to upload file.");
      return;
    }

    const data = await res.json();

    // Determine message type from mime
    let msgType = "FILE";
    if (data.mimeType.startsWith("image/")) msgType = "IMAGE";
    else if (data.mimeType.startsWith("video/")) msgType = "FILE";
    else if (data.mimeType.startsWith("audio/")) msgType = "FILE";

    const msgData = {
      roomId: currentRoomId,
      body: "",
      type: msgType,
      fileUrl: data.url,
      fileName: data.fileName,
      fileMimeType: data.mimeType,
      fileSizeBytes: data.sizeBytes
    };

    if (replyToMessage) {
      msgData.parentId = replyToMessage.id;
    }

    currentSocket.emit("send-message", msgData);
    clearReply();
  } catch (error) {
    console.error("[Chat] File upload error:", error);
    alert("Failed to upload file.");
  }
}

/**
 * Send a voice message from recorded blob.
 */
async function sendVoiceMessage(blob) {
  if (!currentSocket || !currentRoomId || !blob) return;

  const formData = new FormData();
  formData.append("file", blob, `voice-${Date.now()}.webm`);

  try {
    const token = localStorage.getItem("communit_token");
    const res = await fetch("/api/files/upload", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
      body: formData
    });

    if (!res.ok) {
      alert("Failed to upload voice message.");
      return;
    }

    const data = await res.json();

    currentSocket.emit("send-message", {
      roomId: currentRoomId,
      body: "",
      type: "VOICE",
      fileUrl: data.url,
      fileName: data.fileName,
      fileMimeType: data.mimeType,
      fileSizeBytes: data.sizeBytes
    });
  } catch (error) {
    console.error("[Chat] Voice upload error:", error);
    alert("Failed to send voice message.");
  }
}

/**
 * Edit a message.
 */
function editMessage(messageId, newBody) {
  if (!currentSocket || !newBody.trim()) return;
  currentSocket.emit("edit-message", { messageId, body: newBody.trim() });
}

/**
 * Delete a message.
 */
function deleteMessage(messageId) {
  if (!currentSocket) return;
  currentSocket.emit("delete-message", { messageId });
}

/**
 * Set reply target.
 */
function setReply(msg) {
  replyToMessage = msg;
  const bar = document.getElementById("reply-preview-bar");
  const sender = document.getElementById("reply-preview-sender");
  const text = document.getElementById("reply-preview-text");
  if (bar && sender && text) {
    const senderName = msg.sender?.name || msg.sender?.username || "Unknown";
    sender.textContent = senderName;
    if (msg.type === "VOICE") {
      text.innerHTML = '<i class="fa-solid fa-microphone"></i> Voice message';
    } else if (msg.type !== "TEXT" && msg.fileName) {
      text.innerHTML = `<i class="fa-solid fa-paperclip"></i> ${escapeHtml(msg.fileName)}`;
    } else {
      text.textContent = msg.body;
    }
    bar.classList.add("active");
  }
  // Focus input
  document.getElementById("chat-input")?.focus();
}

/**
 * Clear reply state.
 */
function clearReply() {
  replyToMessage = null;
  const bar = document.getElementById("reply-preview-bar");
  if (bar) bar.classList.remove("active");
}

/**
 * Set up reply close button handler.
 */
function setupReplyHandlers() {
  const closeBtn = document.getElementById("reply-preview-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", clearReply);
  }
}

/**
 * Render a message bubble into the chat container.
 */
function renderMessage(msg) {
  if (msg.type === "SYSTEM") {
    renderSystemMessage(msg.body);
    return;
  }

  const container = document.getElementById("chat-messages");
  if (!container) return;

  const currentUser = getCurrentUser();
  const isSelf = msg.sender?.id === currentUser?.id || msg.userId === currentUser?.id;

  const initials = getUserInitials(msg.sender);
  const alignClass = isSelf ? "message--self" : "message--other";

  const time = new Date(msg.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  // Build reply quote HTML if message is a reply
  let replyQuoteHtml = "";
  if (msg.parent) {
    const replySender = msg.parent.sender?.name || msg.parent.sender?.username || "Unknown";
    let replyBodyHtml = "";
    if (msg.parent.type === "VOICE") {
      replyBodyHtml = '<i class="fa-solid fa-microphone"></i> Voice message';
    } else if (msg.parent.type !== "TEXT" && msg.parent.fileName) {
      replyBodyHtml = `<i class="fa-solid fa-paperclip"></i> ${escapeHtml(msg.parent.fileName)}`;
    } else {
      const bodyText = msg.parent.body || "";
      replyBodyHtml = escapeHtml(bodyText.substring(0, 120)) + (bodyText.length > 120 ? "..." : "");
    }
    replyQuoteHtml = `
      <div class="message-reply-quote" data-reply-target="${msg.parent.id}">
        <span class="message-reply-quote-sender">${escapeHtml(replySender)}</span>
        ${replyBodyHtml}
      </div>
    `;
  }

  // Build sender header
  let headerHtml = "";
  if (currentRoomType !== "DIRECT") {
    const fullName = msg.sender?.name || (msg.sender?.username ? `@${msg.sender.username}` : msg.sender?.email) || "Unknown";
    const firstName = fullName.startsWith("@") ? fullName : fullName.split(" ")[0];
    headerHtml = `<span class="message-sender">${escapeHtml(firstName)}</span>`;
  }

  const editedTag = msg.isEdited ? `<span class="message-edited-tag">(edited)</span>` : "";

  // Build content based on message type
  let contentHtml = "";
  const msgType = msg.type || "TEXT";

  if (msgType === "TEXT") {
    contentHtml = `<div class="message-body">${escapeHtml(msg.body)}${editedTag}</div>`;
  } else if (msgType === "VOICE") {
    contentHtml = buildVoiceMessageHtml(msg);
  } else if (msgType === "IMAGE" || (msgType === "FILE" && msg.fileMimeType?.startsWith("image/")) || msgType === "WHITEBOARD") {
    contentHtml = buildImageMessageHtml(msg);
  } else if (msgType === "FILE" && msg.fileMimeType?.startsWith("video/")) {
    contentHtml = buildVideoMessageHtml(msg);
  } else if (msgType === "FILE" && msg.fileMimeType?.startsWith("audio/")) {
    contentHtml = buildAudioFileMessageHtml(msg);
  } else {
    contentHtml = buildDocMessageHtml(msg);
  }

  // Build action buttons
  let actionsHtml = `<div class="message-actions">`;
  actionsHtml += `<button class="message-action-btn" data-action="reply" title="Reply"><i class="fa-solid fa-reply"></i></button>`;
  if (isSelf && msgType === "TEXT") {
    actionsHtml += `<button class="message-action-btn" data-action="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>`;
  }
  if (isSelf) {
    actionsHtml += `<button class="message-action-btn message-action-btn--danger" data-action="delete" title="Delete"><i class="fa-solid fa-trash"></i></button>`;
  }
  actionsHtml += `</div>`;

  const messageEl = document.createElement("div");
  messageEl.className = `message ${alignClass}`;
  messageEl.setAttribute("data-msg-id", msg.id);
  messageEl.innerHTML = `
    <div class="avatar avatar--sm ${isSelf ? 'avatar--green' : 'avatar--orange'}">${initials}</div>
    <div class="message-bubble">
      ${replyQuoteHtml}
      <div class="message-header">
        ${headerHtml}
        <span class="message-time">${time}</span>
      </div>
      ${contentHtml}
    </div>
    ${actionsHtml}
  `;

  // Bind action handlers
  const replyBtn = messageEl.querySelector('[data-action="reply"]');
  const editBtn = messageEl.querySelector('[data-action="edit"]');
  const deleteBtn = messageEl.querySelector('[data-action="delete"]');

  if (replyBtn) {
    replyBtn.addEventListener("click", () => setReply(msg));
  }

  if (editBtn) {
    editBtn.addEventListener("click", () => startInlineEdit(messageEl, msg));
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      if (confirm("Delete this message?")) {
        deleteMessage(msg.id);
      }
    });
  }

  // Click on reply quote to scroll to original
  const quoteEl = messageEl.querySelector(".message-reply-quote");
  if (quoteEl) {
    quoteEl.addEventListener("click", () => {
      const targetId = quoteEl.getAttribute("data-reply-target");
      const targetEl = document.querySelector(`[data-msg-id="${targetId}"]`);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
        targetEl.style.outline = "2px solid var(--accent-green)";
        setTimeout(() => { targetEl.style.outline = ""; }, 1500);
      }
    });
  }

  // Bind image lightbox
  const imgEl = messageEl.querySelector(".message-file-image");
  if (imgEl) {
    imgEl.addEventListener("click", () => {
      const lightbox = document.getElementById("image-lightbox");
      const lightboxImg = document.getElementById("lightbox-img");
      if (lightbox && lightboxImg) {
        lightboxImg.src = imgEl.src;
        lightbox.classList.add("active");
      }
    });
  }

  // Bind voice message playback
  const voicePlayBtn = messageEl.querySelector(".message-voice-play");
  if (voicePlayBtn) {
    setupVoicePlayback(messageEl, msg);
  }

  // Swipe to reply logic (Mobile)
  let startX = 0;
  let currentX = 0;
  let isSwiping = false;

  messageEl.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    isSwiping = true;
    messageEl.classList.add("swiping");
  }, { passive: true });

  messageEl.addEventListener("touchmove", (e) => {
    if (!isSwiping) return;
    currentX = e.touches[0].clientX;
    const diff = currentX - startX;
    
    // Only allow swipe in one direction based on alignment (self->left, other->right)
    // Or just allow any direction, max 60px
    if (Math.abs(diff) < 60) {
      messageEl.style.transform = `translateX(${diff}px)`;
    }
  }, { passive: true });

  messageEl.addEventListener("touchend", () => {
    if (!isSwiping) return;
    isSwiping = false;
    messageEl.classList.remove("swiping");
    messageEl.style.transform = "";

    const diff = currentX - startX;
    if (Math.abs(diff) > 40) { // Threshold reached
      setReply(msg);
      // Vibrate for feedback if supported
      if (navigator.vibrate) navigator.vibrate(50);
    }
    startX = 0;
    currentX = 0;
  });

  container.appendChild(messageEl);
}

// ── Rich Message Builders ──

function buildVoiceMessageHtml(msg) {
  const barCount = 24;
  let barsHtml = "";
  for (let i = 0; i < barCount; i++) {
    const h = Math.floor(Math.random() * 18) + 4;
    barsHtml += `<div class="message-voice-bar" style="height: ${h}px;"></div>`;
  }
  return `
    <div class="message-voice" data-voice-url="${msg.fileUrl}">
      <button class="message-voice-play"><i class="fa-solid fa-play"></i></button>
      <div class="message-voice-waveform">${barsHtml}</div>
      <span class="message-voice-duration">--</span>
      <a href="${msg.fileUrl}" download="voice-message.webm" style="color: var(--accent-green); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-left: 0.5rem; display: inline-flex; align-items: center; text-decoration: none;" title="Download Voice Message"><i class="fa-solid fa-download"></i></a>
    </div>
  `;
}

function buildImageMessageHtml(msg) {
  const isWhiteboard = msg.type === "WHITEBOARD";
  const label = isWhiteboard ? `<div class="message-whiteboard-label" style="font-size: 0.75rem; font-weight: 700; color: var(--accent-orange); margin-bottom: 0.25rem;"><i class="fa-solid fa-clipboard" style="margin-right: 0.25rem;"></i> Shared from Whiteboard</div>` : "";
  const fallbackName = isWhiteboard ? "whiteboard.jpg" : "image.png";
  return `
    <div class="message-file-attachment" style="position: relative;">
      ${label}
      <img class="message-file-image" src="${msg.fileUrl}" alt="${escapeHtml(msg.fileName || fallbackName)}" loading="lazy">
      <div style="margin-top: 0.35rem; display: flex; justify-content: flex-end;">
        <a href="${msg.fileUrl}" download="${escapeHtml(msg.fileName || fallbackName)}" style="font-size: 0.75rem; color: var(--accent-green); display: inline-flex; align-items: center; gap: 0.2rem; font-weight: 600; text-transform: uppercase; text-decoration: none;">
          <i class="fa-solid fa-download"></i> Download
        </a>
      </div>
    </div>
  `;
}

function buildVideoMessageHtml(msg) {
  return `
    <div class="message-file-attachment">
      <video class="message-file-video" controls preload="metadata" style="max-width: 100%; border-radius: var(--radius-sm);">
        <source src="${msg.fileUrl}" type="${msg.fileMimeType}">
      </video>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.65rem; color: var(--text-muted); margin-top: 0.35rem;">
        <span>${escapeHtml(msg.fileName || 'Video')} · ${formatFileSize(msg.fileSizeBytes)}</span>
        <a href="${msg.fileUrl}" download="${escapeHtml(msg.fileName || 'video.mp4')}" style="color: var(--accent-green); font-weight: 600; text-transform: uppercase; display: inline-flex; align-items: center; gap: 0.2rem; text-decoration: none;"><i class="fa-solid fa-download"></i> Download</a>
      </div>
    </div>
  `;
}

function buildAudioFileMessageHtml(msg) {
  return `
    <div class="message-file-audio" style="display: flex; align-items: center; gap: 0.5rem; background: rgba(0,0,0,0.1); padding: 0.5rem; border-radius: var(--radius-sm);">
      <span style="font-size: 1rem; color: var(--accent-green);"><i class="fa-solid fa-music"></i></span>
      <audio controls preload="metadata" style="height: 32px; flex: 1;">
        <source src="${msg.fileUrl}" type="${msg.fileMimeType}">
      </audio>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.65rem; color: var(--text-muted); margin-top: 0.35rem;">
      <span>${escapeHtml(msg.fileName || 'Audio')} · ${formatFileSize(msg.fileSizeBytes)}</span>
      <a href="${msg.fileUrl}" download="${escapeHtml(msg.fileName || 'audio.mp3')}" style="color: var(--accent-green); font-weight: 600; text-transform: uppercase; display: inline-flex; align-items: center; gap: 0.2rem; text-decoration: none;"><i class="fa-solid fa-download"></i> Download</a>
    </div>
  `;
}

function buildDocMessageHtml(msg) {
  const icon = getFileIcon(msg.fileMimeType, msg.fileName);
  return `
    <a class="message-file-doc" href="${msg.fileUrl}" target="_blank" download="${escapeHtml(msg.fileName || 'file')}">
      <span class="message-file-doc-icon">${icon}</span>
      <div class="message-file-doc-info">
        <span class="message-file-doc-name">${escapeHtml(msg.fileName || 'Document')}</span>
        <span class="message-file-doc-size">${formatFileSize(msg.fileSizeBytes)}</span>
      </div>
    </a>
  `;
}

function getFileIcon(mimeType, fileName) {
  if (!mimeType && !fileName) return '<i class="fa-solid fa-file"></i>';
  const m = (mimeType || "").toLowerCase();
  const n = (fileName || "").toLowerCase();
  if (m.includes("pdf") || n.endsWith(".pdf")) return '<i class="fa-solid fa-file-pdf" style="color: #FF5E5E;"></i>';
  if (m.includes("word") || n.endsWith(".doc") || n.endsWith(".docx")) return '<i class="fa-solid fa-file-word" style="color: #4A90E2;"></i>';
  if (m.includes("powerpoint") || m.includes("presentation") || n.endsWith(".ppt") || n.endsWith(".pptx")) return '<i class="fa-solid fa-file-powerpoint" style="color: #FF9F40;"></i>';
  if (m.includes("excel") || m.includes("spreadsheet") || n.endsWith(".xls") || n.endsWith(".xlsx") || n.endsWith(".csv")) return '<i class="fa-solid fa-file-excel" style="color: #2ECC71;"></i>';
  if (m.includes("zip") || n.endsWith(".zip") || n.endsWith(".rar") || n.endsWith(".gzip") || m.includes("rar") || m.includes("gzip")) return '<i class="fa-solid fa-file-zipper" style="color: #F1C40F;"></i>';
  if (m.includes("text") || n.endsWith(".txt")) return '<i class="fa-solid fa-file-lines" style="color: #9B59B6;"></i>';
  return '<i class="fa-solid fa-file"></i>';
}

function formatFileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setupVoicePlayback(messageEl, msg) {
  const playBtn = messageEl.querySelector(".message-voice-play");
  const durationEl = messageEl.querySelector(".message-voice-duration");
  const bars = messageEl.querySelectorAll(".message-voice-bar");
  let audio = null;
  let playing = false;

  playBtn.addEventListener("click", () => {
    if (!audio) {
      audio = new Audio(msg.fileUrl);
      audio.addEventListener("loadedmetadata", () => {
        if (durationEl && isFinite(audio.duration)) {
          durationEl.textContent = formatDuration(audio.duration);
        }
      });
      audio.addEventListener("timeupdate", () => {
        if (!isFinite(audio.duration) || audio.duration === 0) return;
        const progress = audio.currentTime / audio.duration;
        const activeCount = Math.floor(progress * bars.length);
        bars.forEach((bar, i) => {
          bar.classList.toggle("active", i <= activeCount);
        });
      });
      audio.addEventListener("ended", () => {
        playing = false;
        playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        bars.forEach(bar => bar.classList.remove("active"));
      });
    }

    if (playing) {
      audio.pause();
      playing = false;
      playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    } else {
      audio.play();
      playing = true;
      playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    }
  });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Start inline editing of a message.
 */
function startInlineEdit(messageEl, msg) {
  const bodyEl = messageEl.querySelector(".message-body");
  if (!bodyEl) return;

  const originalText = msg.body;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "message-edit-input";
  input.value = originalText;

  bodyEl.innerHTML = "";
  bodyEl.appendChild(input);
  input.focus();
  input.select();

  const finishEdit = (save) => {
    if (save && input.value.trim() && input.value.trim() !== originalText) {
      editMessage(msg.id, input.value.trim());
      // Optimistic: update immediately
      msg.body = input.value.trim();
    }
    bodyEl.innerHTML = escapeHtml(msg.body);
    if (msg.isEdited || save) {
      const tag = document.createElement("span");
      tag.className = "message-edited-tag";
      tag.textContent = "(edited)";
      bodyEl.appendChild(tag);
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finishEdit(true);
    }
    if (e.key === "Escape") {
      finishEdit(false);
    }
  });

  input.addEventListener("blur", () => {
    // Small delay to avoid conflict with keydown
    setTimeout(() => finishEdit(false), 100);
  });
}

/**
 * Render a system message (join/leave notifications).
 */
function renderSystemMessage(text) {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const el = document.createElement("div");
  el.className = "system-message";
  el.textContent = text;
  container.appendChild(el);
}

/**
 * Set up input field event handlers.
 */
function setupInputHandlers() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");

  if (!input || !sendBtn) return;

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const body = input.value;
      if (body.trim()) {
        sendMessage(body);
        input.value = "";
      }
    }
  });

  sendBtn.addEventListener("click", () => {
    const body = input.value;
    if (body.trim()) {
      sendMessage(body);
      input.value = "";
    }
  });

  // Typing indicator
  input.addEventListener("input", () => {
    if (!currentSocket || !currentRoomId) return;
    currentSocket.emit("typing", { roomId: currentRoomId });

    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      currentSocket.emit("stop-typing", { roomId: currentRoomId });
    }, 2000);
  });
}

/**
 * Set up file attachment handlers.
 */
function setupFileHandlers() {
  const fileBtn = document.getElementById("btn-file-attach");
  const fileInput = document.getElementById("file-input-hidden");

  if (fileBtn && fileInput) {
    fileBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (file) {
        sendFileMessage(file);
        fileInput.value = ""; // Reset
      }
    });
  }

  // Lightbox close
  const lightbox = document.getElementById("image-lightbox");
  if (lightbox) {
    lightbox.addEventListener("click", () => {
      lightbox.classList.remove("active");
    });
  }
}

/**
 * Set up voice recording handlers.
 */
function setupVoiceRecordingHandlers() {
  const voiceBtn = document.getElementById("btn-voice-record");
  const overlay = document.getElementById("voice-recording-overlay");
  const cancelBtn = document.getElementById("voice-recording-cancel");
  const sendVoiceBtn = document.getElementById("voice-recording-send");
  const timerEl = document.getElementById("voice-recording-timer");

  if (!voiceBtn) return;

  voiceBtn.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      // Already recording, stop and send
      stopAndSendVoice();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks = [];
      voiceRecordingSeconds = 0;

      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) voiceChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(voiceRecordingTimer);
      };

      mediaRecorder.start();

      // Show overlay
      voiceBtn.classList.add("recording");
      if (overlay) overlay.classList.add("active");

      // Start timer
      voiceRecordingTimer = setInterval(() => {
        voiceRecordingSeconds++;
        if (timerEl) timerEl.textContent = formatDuration(voiceRecordingSeconds);
      }, 1000);

    } catch (err) {
      console.error("[Chat] Microphone access denied:", err);
      alert("Microphone access is required to record voice messages.");
    }
  });

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      cancelVoiceRecording();
    });
  }

  if (sendVoiceBtn) {
    sendVoiceBtn.addEventListener("click", () => {
      stopAndSendVoice();
    });
  }
}

function stopAndSendVoice() {
  const voiceBtn = document.getElementById("btn-voice-record");
  const overlay = document.getElementById("voice-recording-overlay");
  const timerEl = document.getElementById("voice-recording-timer");

  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      clearInterval(voiceRecordingTimer);

      const blob = new Blob(voiceChunks, { type: "audio/webm" });
      if (blob.size > 0) {
        sendVoiceMessage(blob);
      }

      voiceChunks = [];
      voiceRecordingSeconds = 0;
      if (timerEl) timerEl.textContent = "0:00";
    };
    mediaRecorder.stop();
  }

  if (voiceBtn) voiceBtn.classList.remove("recording");
  if (overlay) overlay.classList.remove("active");
}

function cancelVoiceRecording() {
  const voiceBtn = document.getElementById("btn-voice-record");
  const overlay = document.getElementById("voice-recording-overlay");
  const timerEl = document.getElementById("voice-recording-timer");

  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      clearInterval(voiceRecordingTimer);
      voiceChunks = [];
      voiceRecordingSeconds = 0;
      if (timerEl) timerEl.textContent = "0:00";
    };
    mediaRecorder.stop();
  }

  if (voiceBtn) voiceBtn.classList.remove("recording");
  if (overlay) overlay.classList.remove("active");
}

/**
 * Scroll chat container to bottom.
 */
function scrollToBottom() {
  const container = document.getElementById("chat-messages");
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Cleanup chat listeners.
 */
export function destroyChat() {
  if (currentSocket && currentRoomId) {
    currentSocket.emit("leave-room", { roomId: currentRoomId });
    currentSocket.off("room-history");
    currentSocket.off("new-message");
    currentSocket.off("message-edited");
    currentSocket.off("message-deleted");
    currentSocket.off("user-typing");
    currentSocket.off("user-stop-typing");
    currentSocket.off("user-joined");
    currentSocket.off("user-left");
    currentSocket.off("room-deleted");
    currentSocket.off("member-added");
    currentSocket.off("member-removed");
    currentSocket.off("chat-cleared");
  }
  currentRoomId = null;
  clearReply();
  cancelVoiceRecording();
}
