/**
 * audio-call.js — Client-side WebRTC audio calling
 * Handles mesh audio connection between DM and Group participants.
 */

import { getCurrentUser, getUserInitials, getDisplayName } from "./auth.js";
import { getSocket } from "./socket.js";

let socket = null;
let currentUser = null;
let localStream = null;
let activeRoomId = null;
let activeRoomName = "";
let isGroupCall = false;

const peers = {}; // socketId -> RTCPeerConnection
const participants = {}; // socketId -> { name, userId }
let localStreamMuted = false;
let isMinimized = false;
let callTimerInterval = null;
let callDurationSeconds = 0;

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

/**
 * Initialize audio call listener. Call this on dashboard load.
 */
export async function initAudioCallListeners() {
  socket = await getSocket();
  currentUser = getCurrentUser();

  socket.on("incoming-audio-call", (data) => {
    showIncomingAudioCallPopup(data);
  });

  socket.on("audio-user-joined", handleAudioUserJoined);
  socket.on("audio-offer", handleAudioOffer);
  socket.on("audio-answer", handleAudioAnswer);
  socket.on("audio-ice-candidate", handleAudioNewICECandidate);
  socket.on("audio-user-left", handleAudioUserLeft);

  // Bind popup buttons
  const acceptBtn = document.getElementById("audio-call-accept-btn");
  const declineBtn = document.getElementById("audio-call-decline-btn");
  if (acceptBtn) {
    acceptBtn.onclick = () => acceptAudioCall();
  }
  if (declineBtn) {
    declineBtn.onclick = () => declineAudioCall();
  }

  // Bind active call modal controls
  const muteBtn = document.getElementById("btn-audio-mute");
  const hangupBtn = document.getElementById("btn-audio-hangup");
  const minimizeBtn = document.getElementById("btn-audio-minimize");
  if (muteBtn) {
    muteBtn.onclick = () => toggleAudioMute();
  }
  if (hangupBtn) {
    hangupBtn.onclick = () => hangupAudioCall();
  }
  if (minimizeBtn) {
    minimizeBtn.onclick = () => minimizeAudioCall();
  }

  // Bind PiP controls
  const pipMuteBtn = document.getElementById("btn-pip-mute");
  const pipHangupBtn = document.getElementById("btn-pip-hangup");
  const pipExpandBtn = document.getElementById("btn-pip-expand");
  if (pipMuteBtn) {
    pipMuteBtn.onclick = () => toggleAudioMute();
  }
  if (pipHangupBtn) {
    pipHangupBtn.onclick = () => hangupAudioCall();
  }
  if (pipExpandBtn) {
    pipExpandBtn.onclick = () => expandAudioCall();
  }
}

/**
 * Request an audio call (initiator side).
 */
export async function startAudioCall(roomId, roomName, groupCall = false) {
  activeRoomId = roomId;
  activeRoomName = roomName;
  isGroupCall = groupCall;
  localStreamMuted = false;

  const typeText = isGroupCall ? "Group Call" : "DM Call";
  console.log(`[Audio Call] Starting ${typeText} call in room ${roomId}...`);

  // Request mic access first
  const hasMic = await getLocalAudioStream();
  if (!hasMic) {
    alert("Microphone access is required to make an audio call.");
    return;
  }

  // Show active call box modal
  showAudioCallBox();

  // Socket request
  socket.emit("request-audio-call", {
    roomId,
    roomName,
    isGroupCall
  });

  // Join signaling room
  socket.emit("join-audio-call", { roomId });
}

/**
 * Show the incoming audio call notification toast.
 */
function showIncomingAudioCallPopup(data) {
  const popup = document.getElementById("incoming-audio-call-popup");
  const title = document.getElementById("incoming-audio-call-title");
  const type = document.getElementById("incoming-audio-call-type");

  if (!popup || !title || !type) return;

  activeRoomId = data.roomId;
  activeRoomName = data.roomName;
  isGroupCall = data.isGroupCall;

  title.textContent = getDisplayName(data.callerId, data.callerName);
  type.textContent = isGroupCall ? `Group Audio Call (via ${activeRoomName})` : "Direct Audio Call";

  popup.style.display = "block";

  // Auto decline after 30 seconds if unanswered
  if (popup.dataset.timeoutId) {
    clearTimeout(parseInt(popup.dataset.timeoutId, 10));
  }
  const timeoutId = setTimeout(() => {
    declineAudioCall();
  }, 30000);
  popup.dataset.timeoutId = timeoutId.toString();
}

/**
 * Accept the incoming call.
 */
async function acceptAudioCall() {
  const popup = document.getElementById("incoming-audio-call-popup");
  if (popup) {
    popup.style.display = "none";
    if (popup.dataset.timeoutId) {
      clearTimeout(parseInt(popup.dataset.timeoutId, 10));
    }
  }

  // Get mic permissions
  const hasMic = await getLocalAudioStream();
  if (!hasMic) {
    alert("Microphone access is required to accept the audio call.");
    return;
  }

  // Show the active call screen
  showAudioCallBox();

  // Join room
  socket.emit("join-audio-call", { roomId: activeRoomId });
}

/**
 * Decline the incoming call.
 */
function declineAudioCall() {
  const popup = document.getElementById("incoming-audio-call-popup");
  if (popup) {
    popup.style.display = "none";
    if (popup.dataset.timeoutId) {
      clearTimeout(parseInt(popup.dataset.timeoutId, 10));
    }
  }
  activeRoomId = null;
  activeRoomName = "";
}

/**
 * Hangup/Leave the audio call.
 */
export function hangupAudioCall() {
  console.log("[Audio Call] Hanging up...");

  // Notify server/other users
  if (socket && activeRoomId) {
    socket.emit("leave-audio-call", { roomId: activeRoomId });
  }

  // Stop local mic stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Close peer connections
  Object.keys(peers).forEach(sid => {
    if (peers[sid]) {
      peers[sid].close();
      delete peers[sid];
    }
    removeAudioElement(sid);
  });

  // Clear participants
  Object.keys(participants).forEach(sid => delete participants[sid]);

  // Hide modal and PiP
  const modal = document.getElementById("audio-call-box");
  if (modal) modal.classList.remove("active");
  const pip = document.getElementById("audio-call-pip");
  if (pip) pip.classList.remove("active");

  // Clear call timer
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callDurationSeconds = 0;

  activeRoomId = null;
  activeRoomName = "";
  localStreamMuted = false;
  isMinimized = false;
  
  const muteBtn = document.getElementById("btn-audio-mute");
  if (muteBtn) {
    muteBtn.classList.add("active");
    muteBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
  }
}

/**
 * Request microphone input.
 */
async function getLocalAudioStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return true;
  } catch (err) {
    console.error("[Audio Call] Failed to get local microphone:", err);
    return false;
  }
}

/**
 * Show active call box overlay modal.
 */
function showAudioCallBox() {
  const modal = document.getElementById("audio-call-box");
  const nameEl = document.getElementById("audio-call-room-name");

  if (!modal) return;

  if (nameEl) {
    nameEl.textContent = isGroupCall ? activeRoomName : `Direct Call`;
  }

  modal.classList.add("active");
  isMinimized = false;
  updateAudioCallParticipantsUI();
  startCallTimer();
}

/**
 * Start call duration timer.
 */
function startCallTimer() {
  clearInterval(callTimerInterval);
  callDurationSeconds = 0;
  const pipTimerEl = document.getElementById("audio-call-pip-timer");

  callTimerInterval = setInterval(() => {
    callDurationSeconds++;
    const m = Math.floor(callDurationSeconds / 60);
    const s = callDurationSeconds % 60;
    const timeStr = `${m}:${s.toString().padStart(2, "0")}`;
    if (pipTimerEl) pipTimerEl.textContent = timeStr;
  }, 1000);
}

/**
 * Minimize full audio call modal to PiP widget.
 */
function minimizeAudioCall() {
  const modal = document.getElementById("audio-call-box");
  const pip = document.getElementById("audio-call-pip");
  const pipName = document.getElementById("audio-call-pip-name");
  const pipMuteBtn = document.getElementById("btn-pip-mute");

  if (modal) modal.classList.remove("active");
  if (pip) pip.classList.add("active");
  if (pipName) pipName.textContent = isGroupCall ? activeRoomName : "Direct Call";
  if (pipMuteBtn) {
    pipMuteBtn.classList.toggle("active", !localStreamMuted);
    pipMuteBtn.innerHTML = localStreamMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }
  isMinimized = true;
}

/**
 * Expand PiP widget back to full audio call modal.
 */
function expandAudioCall() {
  const modal = document.getElementById("audio-call-box");
  const pip = document.getElementById("audio-call-pip");

  if (pip) pip.classList.remove("active");
  if (modal) modal.classList.add("active");
  isMinimized = false;
  updateAudioCallParticipantsUI();
}

/**
 * Toggle local microphone mute state.
 */
function toggleAudioMute() {
  const muteBtn = document.getElementById("btn-audio-mute");
  const pipMuteBtn = document.getElementById("btn-pip-mute");
  if (!localStream) return;

  localStreamMuted = !localStreamMuted;
  localStream.getAudioTracks().forEach(track => track.enabled = !localStreamMuted);

  if (muteBtn) {
    muteBtn.classList.toggle("active", !localStreamMuted);
    muteBtn.innerHTML = localStreamMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }
  if (pipMuteBtn) {
    pipMuteBtn.classList.toggle("active", !localStreamMuted);
    pipMuteBtn.innerHTML = localStreamMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }
  updateAudioCallParticipantsUI();
}

/**
 * Redraw the avatars and names in the modal.
 */
function updateAudioCallParticipantsUI() {
  const container = document.getElementById("audio-call-participants");
  if (!container) return;
  container.innerHTML = "";

  // 1. Render Local User
  const localDiv = document.createElement("div");
  localDiv.style.display = "flex";
  localDiv.style.flexDirection = "column";
  localDiv.style.alignItems = "center";
  localDiv.style.gap = "0.4rem";

  const initials = getUserInitials(currentUser);
  const name = currentUser?.name || currentUser?.username || "Me";
  const firstName = name.split(" ")[0];

  localDiv.innerHTML = `
    <div class="avatar avatar--md avatar--green" style="width: 60px; height: 60px; font-size: 1.4rem; font-weight:700;">${initials}</div>
    <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-primary); text-transform: uppercase;">
      You ${localStreamMuted ? "(Mute)" : ""}
    </span>
  `;
  container.appendChild(localDiv);

  // 2. Render Remote Participants
  Object.keys(participants).forEach(sid => {
    const p = participants[sid];
    const resolvedName = getDisplayName(p.userId, p.name);
    const pInitials = getUserInitials({ name: resolvedName });
    const pFirstName = resolvedName.split(" ")[0];

    const remoteDiv = document.createElement("div");
    remoteDiv.style.display = "flex";
    remoteDiv.style.flexDirection = "column";
    remoteDiv.style.alignItems = "center";
    remoteDiv.style.gap = "0.4rem";

    remoteDiv.innerHTML = `
      <div class="avatar avatar--md avatar--orange" style="width: 60px; height: 60px; font-size: 1.4rem; font-weight:700;">${pInitials}</div>
      <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-primary); text-transform: uppercase;">
        ${escapeHtml(pFirstName)}
      </span>
    `;
    container.appendChild(remoteDiv);
  });
}

/**
 * Signaling mesh: another user joined the audio call.
 */
async function handleAudioUserJoined({ socketId, userId, name }) {
  console.log(`[Audio Call] Remote user joined: ${name} (${socketId})`);
  participants[socketId] = { name, userId };
  updateAudioCallParticipantsUI();

  // Create PeerConnection
  const pc = createPeerConnection(socketId, name);
  peers[socketId] = pc;

  // Add audio tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // Create offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("audio-offer", { targetSocketId: socketId, offer });
  } catch (err) {
    console.error("[Audio Call] Create offer failed:", err);
  }
}

/**
 * Signaling mesh: received offer from joining user.
 */
async function handleAudioOffer({ fromSocketId, fromUserId, name, offer }) {
  console.log(`[Audio Call] Received offer from ${name} (${fromSocketId})`);
  participants[fromSocketId] = { name, userId: fromUserId };
  updateAudioCallParticipantsUI();

  const pc = createPeerConnection(fromSocketId, name);
  peers[fromSocketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("audio-answer", { targetSocketId: fromSocketId, answer });
  } catch (err) {
    console.error("[Audio Call] Set remote/create answer failed:", err);
  }
}

/**
 * Signaling mesh: received answer from offer recipient.
 */
async function handleAudioAnswer({ fromSocketId, answer }) {
  console.log(`[Audio Call] Received answer from ${fromSocketId}`);
  const pc = peers[fromSocketId];
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error("[Audio Call] Set remote answer failed:", err);
    }
  }
}

/**
 * Signaling mesh: received ICE candidate.
 */
async function handleAudioNewICECandidate({ fromSocketId, candidate }) {
  const pc = peers[fromSocketId];
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("[Audio Call] Add ICE candidate failed:", err);
    }
  }
}

/**
 * User left audio call.
 */
function handleAudioUserLeft({ socketId }) {
  console.log(`[Audio Call] User left: ${socketId}`);
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  removeAudioElement(socketId);
  delete participants[socketId];
  updateAudioCallParticipantsUI();

  // If there are no more remote participants left in the call, automatically hang up
  if (Object.keys(participants).length === 0) {
    console.log("[Audio Call] No participants remaining. Ending call.");
    hangupAudioCall();
  }
}

/**
 * Helper to build PeerConnection.
 */
function createPeerConnection(targetSocketId, name) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("audio-ice-candidate", {
        targetSocketId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    console.log(`[Audio Call] Received track from ${name}`);
    const stream = event.streams[0];
    let audioEl = document.getElementById(`audio-elem-${targetSocketId}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `audio-elem-${targetSocketId}`;
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
  };

  return pc;
}

/**
 * Clean up dynamically created audio tag.
 */
function removeAudioElement(sid) {
  const el = document.getElementById(`audio-elem-${sid}`);
  if (el) el.remove();
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
