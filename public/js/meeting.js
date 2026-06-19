/**
 * meeting.js — Client-side video meeting page logic
 * Manages full screen Google Meet-style WebRTC call, screen share, and audio/video controls.
 */

import { authGuard, authFetch, getCurrentUser, getUserInitials, getDisplayName } from "./auth.js";
import { getSocket } from "./socket.js";
import { initWhiteboard, registerRemoteWhiteboard, unregisterRemoteWhiteboard, resizeAllCanvases } from "./whiteboard.js";
import { initAnnotations, toggleScreenAnnotations, setLocalScreenSharingState } from "./annotation.js";

// Guard redirect
if (!authGuard()) {
  throw new Error("Not authenticated");
}

const currentUser = getCurrentUser();
const params = new URLSearchParams(window.location.search);
const meetingCode = params.get("code");

if (!meetingCode) {
  alert("No meeting code provided.");
  window.location.href = "/dashboard.html";
}

let socket = null;
let meetingId = null;
let meetingHostId = null;
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let micEnabled = true;
let camEnabled = true;

const peers = {}; // socketId -> RTCPeerConnection
const participants = {}; // socketId -> { name, userId, video, audio }

let pinnedParticipantId = null;
let whiteboardPresenterId = null;


const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// Initialize Meeting
async function initMeeting() {
  try {
    // 1. Fetch meeting info
    const res = await authFetch(`/api/meetings/${meetingCode}`);
    if (!res || !res.ok) {
      let errMsg = "Meeting not found or you are not invited.";
      if (res) {
        try {
          const errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch (_) {}
      }
      alert(errMsg);
      window.location.href = "/dashboard.html";
      return;
    }
    const data = await res.json();
    const meeting = data.meeting;
    meetingId = meeting.id;
    meetingHostId = meeting.hostId;

    document.getElementById("meeting-title").textContent = meeting.title;
    document.getElementById("meeting-code").textContent = meeting.code;



    // 2. Request user media permissions
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      console.warn("[Meeting] Camera + Mic access failed, trying audio-only or video-only...", err);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        camEnabled = false;
        const btnCam = document.getElementById("btn-toggle-cam");
        if (btnCam) btnCam.classList.remove("active");
      } catch (err2) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          micEnabled = false;
          const btnMic = document.getElementById("btn-toggle-mic");
          if (btnMic) btnMic.classList.remove("active");
        } catch (err3) {
          console.error("[Meeting] Could not access any media device:", err3);
          alert("Could not access camera or microphone. You will join in view-only mode.");
          localStream = new MediaStream();
          camEnabled = false;
          micEnabled = false;
        }
      }
    }

    // 3. Render Local Video Tile
    addVideoTile("local", currentUser.name || `@${currentUser.username}`, localStream, true);
    updateMediaStateUI("local", camEnabled, micEnabled);

    // 4. Setup socket and signaling listeners
    socket = await getSocket();
    initWhiteboard(socket, meetingCode);
    initAnnotations(socket, meetingCode, currentUser);
    socket.emit("join-meeting", { meetingCode });

    socket.on("meeting-user-joined", handleUserJoined);
    socket.on("meeting-offer", handleOffer);
    socket.on("meeting-answer", handleAnswer);
    socket.on("meeting-ice-candidate", handleNewICECandidate);
    socket.on("meeting-user-left", handleUserLeft);
    socket.on("meeting-ended", handleMeetingEnded);
    socket.on("meeting-user-media-toggled", handleUserMediaToggled);
    socket.on("meeting-kicked", handleMeetingKicked);
    socket.on("meeting-whiteboard-toggled", ({ presenterId, active }) => {
      if (active) {
        if (presenterId === socket.id) {
          showWhiteboardInTile("local");
          pinParticipant("local");
        } else {
          showRemoteWhiteboardInTile(presenterId);
          pinParticipant(presenterId);
        }
      } else {
        if (presenterId === socket.id) {
          hideWhiteboardFromTile();
          if (pinnedParticipantId === "local") {
            unpinParticipant();
          }
        } else {
          hideRemoteWhiteboardFromTile(presenterId);
          if (pinnedParticipantId === presenterId) {
            unpinParticipant();
          }
        }
      }
      if (presenterId === socket.id) {
        const btn = document.getElementById("btn-toggle-whiteboard");
        if (btn) btn.classList.toggle("active", active);
      }
    });

    // Share initial media state
    socket.emit("meeting-toggle-media", {
      meetingCode,
      video: camEnabled,
      audio: micEnabled
    });

    // 5. Setup UI buttons listeners
    setupControls();

    // Load initial list in sidebar
    updateParticipantSidebar();

  } catch (error) {
    console.error("[Meeting] Initialization error:", error);
    alert("Error initializing meeting call.");
  }
}

// Control buttons
function setupControls() {
  const btnMic = document.getElementById("btn-toggle-mic");
  const btnCam = document.getElementById("btn-toggle-cam");
  const btnShare = document.getElementById("btn-share-screen");
  const btnLeave = document.getElementById("btn-leave-meeting");
  const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
  const btnCloseSidebar = document.getElementById("btn-close-sidebar");
  const sidebar = document.getElementById("meeting-sidebar");

  if (btnMic) {
    btnMic.addEventListener("click", () => {
      micEnabled = !micEnabled;
      if (localStream) {
        localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
      }
      btnMic.classList.toggle("active", micEnabled);
      updateMediaStateUI("local", camEnabled, micEnabled);
      socket.emit("meeting-toggle-media", { meetingCode, video: camEnabled, audio: micEnabled });
    });
  }

  if (btnCam) {
    btnCam.addEventListener("click", () => {
      camEnabled = !camEnabled;
      if (localStream) {
        localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
      }
      btnCam.classList.toggle("active", camEnabled);
      updateMediaStateUI("local", camEnabled, micEnabled);
      socket.emit("meeting-toggle-media", { meetingCode, video: camEnabled, audio: micEnabled });
    });
  }

  if (btnShare) {
    btnShare.addEventListener("click", toggleScreenShare);
  }

  if (btnLeave) {
    btnLeave.addEventListener("click", leaveMeeting);
  }

  if (btnToggleSidebar && sidebar) {
    btnToggleSidebar.addEventListener("click", () => {
      sidebar.classList.toggle("hidden");
    });
  }

  if (btnCloseSidebar && sidebar) {
    btnCloseSidebar.addEventListener("click", () => {
      sidebar.classList.add("hidden");
    });
  }

  // Setup Autocomplete suggestions & invite button handler
  setupAutocomplete("invite-username-input", "invite-username-suggestions");

  const btnInvite = document.getElementById("btn-invite-member");
  const inviteInput = document.getElementById("invite-username-input");

  if (inviteInput) {
    inviteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        inviteMemberFromInput();
      }
    });
  }

  if (btnInvite) {
    btnInvite.addEventListener("click", (e) => {
      e.preventDefault();
      inviteMemberFromInput();
    });
  }

  const btnToggleWhiteboard = document.getElementById("btn-toggle-whiteboard");
  if (btnToggleWhiteboard) {
    btnToggleWhiteboard.addEventListener("click", () => {
      const active = !btnToggleWhiteboard.classList.contains("active");
      if (active) {
        btnToggleWhiteboard.classList.add("active");
        showWhiteboardInTile("local");
        socket.emit("meeting-toggle-whiteboard", { meetingCode, active: true });
        pinParticipant("local");
      } else {
        btnToggleWhiteboard.classList.remove("active");
        hideWhiteboardFromTile();
        socket.emit("meeting-toggle-whiteboard", { meetingCode, active: false });
        if (pinnedParticipantId === "local") {
          unpinParticipant();
        }
      }
    });
  }

  const btnAnnotateScreen = document.getElementById("btn-annotate-screen");
  if (btnAnnotateScreen) {
    btnAnnotateScreen.addEventListener("click", () => {
      toggleScreenAnnotations();
    });
  }

  const wbToolbarToggle = document.getElementById("wb-toolbar-toggle");
  const wbToolbarContainer = document.getElementById("wb-toolbar-container");
  if (wbToolbarToggle && wbToolbarContainer) {
    wbToolbarToggle.addEventListener("click", () => {
      wbToolbarContainer.classList.toggle("hidden");
    });
  }
}

// Add Video Tile to DOM Grid
function addVideoTile(id, name, stream, isLocal) {
  const grid = document.getElementById("video-grid");
  if (!grid) return;

  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.id = `tile-${id}`;
    tile.className = "meeting-video-tile";

    const video = document.createElement("video");
    video.id = `video-${id}`;
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) {
      video.muted = true;
      video.style.transform = "scaleX(-1)"; // Mirror local video
    }

    let displayName = name;
    if (!isLocal && participants[id]) {
      displayName = getDisplayName(participants[id].userId, name);
    }

    const avatar = document.createElement("div");
    avatar.id = `avatar-${id}`;
    avatar.className = "meeting-video-tile-avatar hidden";
    avatar.textContent = getUserInitials({ name: displayName });

    const nameBar = document.createElement("div");
    nameBar.className = "meeting-video-tile-name";
    nameBar.textContent = displayName;

    // Pin button
    const pinBtn = document.createElement("button");
    pinBtn.className = "tile-pin-btn";
    pinBtn.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
    pinBtn.title = "Pin Video";
    pinBtn.onclick = (e) => {
      e.stopPropagation();
      togglePin(id);
    };

    tile.appendChild(video);
    tile.appendChild(avatar);
    tile.appendChild(nameBar);
    tile.appendChild(pinBtn);

    tile.ondblclick = (e) => {
      e.stopPropagation();
      togglePin(id);
    };

    // If pinned layout is active, append new tile to the strip (unless it's the pinned one or local)
    if (pinnedParticipantId) {
      if (id === pinnedParticipantId) {
        tile.classList.add("tile-pinned");
        grid.appendChild(tile);
      } else if (id === "local") {
        tile.classList.add("tile-pip");
        grid.appendChild(tile);
      } else {
        tile.classList.add("tile-strip");
        let strip = document.getElementById("meeting-pin-strip");
        if (!strip) {
          strip = document.createElement("div");
          strip.id = "meeting-pin-strip";
          strip.className = "meeting-pin-strip";
          grid.appendChild(strip);
        }
        strip.appendChild(tile);
      }
    } else {
      grid.appendChild(tile);
    }
  }

  const videoEl = document.getElementById(`video-${id}`);
  if (videoEl && videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
  }

  // If this tile is the whiteboard presenter, we must re-embed the whiteboard container inside it
  if (whiteboardPresenterId === id) {
    const wb = document.getElementById("meeting-whiteboard");
    if (wb && wb.parentElement !== tile) {
      tile.appendChild(wb);
    }
  }

  updateVideoGridLayout();
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) {
    tile.remove();
  }
  unregisterRemoteWhiteboard(id);
  if (pinnedParticipantId === id) {
    unpinParticipant();
  } else if (pinnedParticipantId) {
    // Refresh strip and overlay positions
    pinParticipant(pinnedParticipantId);
  }
  updateVideoGridLayout();
}

function updateVideoGridLayout() {
  const grid = document.getElementById("video-grid");
  if (!grid) return;
  const tiles = grid.querySelectorAll(".meeting-video-tile");
  grid.setAttribute("data-count", tiles.length.toString());
  
  if (window.innerWidth <= 768) {
    if (pinnedParticipantId) {
      grid.classList.add("mobile-pinned-view");
      grid.classList.remove("mobile-carousel");
    } else {
      grid.classList.remove("mobile-pinned-view");
      if (tiles.length > 4) {
        grid.classList.add("mobile-carousel");
      } else {
        grid.classList.remove("mobile-carousel");
      }
    }
  } else {
    grid.classList.remove("mobile-pinned-view");
    grid.classList.remove("mobile-carousel");
  }

  // Call resizeAllCanvases to resize canvases
  setTimeout(resizeAllCanvases, 50);
}

function updateMediaStateUI(id, videoEnabled, audioEnabled) {
  const videoEl = document.getElementById(`video-${id}`);
  const avatarEl = document.getElementById(`avatar-${id}`);
  
  if (videoEl && avatarEl) {
    if (videoEnabled) {
      videoEl.classList.remove("hidden");
      avatarEl.classList.add("hidden");
    } else {
      videoEl.classList.add("hidden");
      avatarEl.classList.remove("hidden");
    }
  }
}

// WebRTC logic (mesh)

// Handle another user joining
async function handleUserJoined({ socketId, userId, name }) {
  console.log(`[Meeting] User joined: ${name} (${socketId})`);
  participants[socketId] = { name, userId, video: true, audio: true };
  updateParticipantSidebar();

  // Create PC
  const pc = createPeerConnection(socketId, name);
  peers[socketId] = pc;

  // Add tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // Offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("meeting-offer", {
      targetSocketId: socketId,
      offer
    });
  } catch (error) {
    console.error("[Meeting] Offer creation error:", error);
  }
}

// Handle offer from another user
async function handleOffer({ fromSocketId, fromUserId, name, offer }) {
  console.log(`[Meeting] Received offer from: ${name} (${fromSocketId})`);
  participants[fromSocketId] = { name, userId: fromUserId, video: true, audio: true };
  updateParticipantSidebar();

  const pc = createPeerConnection(fromSocketId, name);
  peers[fromSocketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("meeting-answer", {
      targetSocketId: fromSocketId,
      answer
    });
  } catch (error) {
    console.error("[Meeting] Answer creation error:", error);
  }
}

// Handle answer
async function handleAnswer({ fromSocketId, answer }) {
  console.log(`[Meeting] Received answer from: ${fromSocketId}`);
  const pc = peers[fromSocketId];
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      console.error("[Meeting] remote description error:", error);
    }
  }
}

// Handle candidate
async function handleNewICECandidate({ fromSocketId, candidate }) {
  const pc = peers[fromSocketId];
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error("[Meeting] ICE candidate error:", error);
    }
  }
}

// Create connection
function createPeerConnection(targetSocketId, name) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("meeting-ice-candidate", {
        targetSocketId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    addVideoTile(targetSocketId, name, stream, false);
    
    // Sync remote participant's media visibility state if we already have it
    const info = participants[targetSocketId];
    if (info) {
      updateMediaStateUI(targetSocketId, info.video, info.audio);
    }
  };

  return pc;
}

// Media Toggled handler
function handleUserMediaToggled({ socketId, video, audio }) {
  if (participants[socketId]) {
    participants[socketId].video = video;
    participants[socketId].audio = audio;
  }
  updateMediaStateUI(socketId, video, audio);
}

// Screen Sharing
async function toggleScreenShare() {
  const btnShare = document.getElementById("btn-share-screen");
  if (!btnShare) return;

  if (isScreenSharing) {
    stopScreenShare();
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      isScreenSharing = true;
      btnShare.classList.add("active");
      
      socket.emit("meeting-toggle-screen-share", { meetingCode, sharing: true });
      setLocalScreenSharingState(true);

      const screenTrack = screenStream.getVideoTracks()[0];
      
      // Replace video tracks in peers
      Object.keys(peers).forEach(socketId => {
        const pc = peers[socketId];
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === "video");
        if (videoSender) {
          videoSender.replaceTrack(screenTrack);
        }
      });

      // Update local tile video
      const localVideo = document.getElementById("video-local");
      if (localVideo) {
        localVideo.srcObject = screenStream;
        localVideo.style.transform = "none"; // Don't mirror screen
      }

      // Handle user stopping screen share from browser controls
      screenTrack.onended = () => {
        stopScreenShare();
      };

    } catch (error) {
      console.error("[Meeting] Screen share failed:", error);
      alert("Failed to share screen.");
    }
  }
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  isScreenSharing = false;

  const btnShare = document.getElementById("btn-share-screen");
  if (btnShare) btnShare.classList.remove("active");
  
  socket.emit("meeting-toggle-screen-share", { meetingCode, sharing: false });
  setLocalScreenSharingState(false);

  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  // Restore camera track in peers
  if (localStream) {
    const cameraTrack = localStream.getVideoTracks()[0];
    Object.keys(peers).forEach(socketId => {
      const pc = peers[socketId];
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === "video");
      if (videoSender && cameraTrack) {
        videoSender.replaceTrack(cameraTrack);
      }
    });

    const localVideo = document.getElementById("video-local");
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.style.transform = "scaleX(-1)"; // Mirror back local video
    }
  }
}

// Participant Left
function handleUserLeft({ userId, socketId }) {
  console.log(`[Meeting] User left call: ${socketId}`);
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  delete participants[socketId];
  if (whiteboardPresenterId === socketId) {
    hideWhiteboardFromTile();
    const btn = document.getElementById("btn-toggle-whiteboard");
    if (btn) btn.classList.remove("active");
  }
  removeVideoTile(socketId);
  updateParticipantSidebar();
}

// Leave Meeting
function leaveMeeting() {
  stopScreenShare();

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  Object.keys(peers).forEach(socketId => {
    peers[socketId].close();
    delete peers[socketId];
  });

  if (socket) {
    socket.emit("leave-meeting", { meetingCode });
    socket.off("meeting-user-joined");
    socket.off("meeting-offer");
    socket.off("meeting-answer");
    socket.off("meeting-ice-candidate");
    socket.off("meeting-user-left");
    socket.off("meeting-ended");
    socket.off("meeting-user-media-toggled");
  }

  window.location.href = "/dashboard.html";
}

// End Meeting (Host Only)
async function endMeeting() {
  if (meetingHostId !== currentUser.id) return;

  if (confirm("Are you sure you want to end the meeting for everyone?")) {
    try {
      const res = await authFetch(`/api/meetings/${meetingId}`, {
        method: "DELETE"
      });

      if (res && res.ok) {
        if (socket) {
          socket.emit("end-meeting", { meetingCode });
        }
        leaveMeeting();
      } else {
        alert("Failed to end meeting.");
      }
    } catch (err) {
      console.error("[Meeting] Failed to end meeting:", err);
      alert("Error ending meeting.");
    }
  }
}

// Host Ended Meeting listener
function handleMeetingEnded() {
  alert("The host has ended this meeting.");
  leaveMeeting();
}

// Sidebar list update
function updateParticipantSidebar() {
  const countEl = document.getElementById("participant-count");
  const listEl = document.getElementById("meeting-sidebar-list");

  if (!countEl || !listEl) return;

  const totalCount = Object.keys(participants).length + 1; // plus local user
  countEl.textContent = totalCount;

  listEl.innerHTML = "";

  // Add Local user first
  const localItem = document.createElement("div");
  localItem.className = "meeting-sidebar-item";
  localItem.innerHTML = `
    <div class="avatar avatar--sm avatar--green" style="font-size: 0.6rem; width: 20px; height: 20px; border:none!important;">${getUserInitials(currentUser)}</div>
    <span style="font-weight:700;">You</span>
  `;
  listEl.appendChild(localItem);

  // Add Remote participants
  Object.keys(participants).forEach(socketId => {
    const info = participants[socketId];
    const displayName = getDisplayName(info.userId, info.name);
    const remoteItem = document.createElement("div");
    remoteItem.className = "meeting-sidebar-item";
    remoteItem.style.justifyContent = "space-between";
    remoteItem.style.display = "flex";
    remoteItem.style.alignItems = "center";
    remoteItem.style.width = "100%";
    
    let kickBtnHtml = "";
    if (meetingHostId === currentUser.id) {
      kickBtnHtml = `<button class="btn-kick-member" data-socketid="${socketId}" style="background: transparent; color: var(--text-danger); border: 1.5px solid var(--text-danger); border-radius: var(--radius-sm); font-size: 0.6rem; padding: 0.1rem 0.35rem; font-weight: 700; cursor: pointer; transition: var(--transition);">KICK</button>`;
    }
    
    remoteItem.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.6rem;">
        <div class="avatar avatar--sm avatar--orange" style="font-size: 0.6rem; width: 20px; height: 20px; border:none!important;">${getUserInitials({ name: displayName })}</div>
        <span>${displayName}</span>
      </div>
      ${kickBtnHtml}
    `;
    
    const kickBtn = remoteItem.querySelector(".btn-kick-member");
    if (kickBtn) {
      kickBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetSid = e.target.dataset.socketid;
        if (confirm(`Are you sure you want to kick ${displayName} from the meeting?`)) {
          socket.emit("kick-participant", { meetingCode, targetSocketId: targetSid });
        }
      };
    }
    listEl.appendChild(remoteItem);
  });
}

// Start
document.addEventListener("DOMContentLoaded", initMeeting);
window.onbeforeunload = leaveMeeting;

// --- AUTOCOMPLETE & INVITE HELPERS ---

async function setupAutocomplete(inputId, suggestionsId) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(suggestionsId);
  if (!input || !dropdown) return;

  let dmContacts = [];

  // Fetch DM contacts on load
  try {
    const res = await authFetch("/api/auth/contacts");
    if (res && res.ok) {
      const data = await res.json();
      dmContacts = data.contacts || [];
    }
  } catch (err) {
    console.error("Failed to fetch DM contacts for autocomplete:", err);
  }

  function showDMSuggestions() {
    dropdown.innerHTML = "";
    if (dmContacts.length === 0) {
      dropdown.innerHTML = `<div style="padding: 0.5rem; color: var(--text-secondary); font-size: 0.75rem; font-style: italic;">No DM contacts to invite</div>`;
    } else {
      dmContacts.forEach(user => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.style.padding = "0.4rem 0.6rem";
        item.style.fontSize = "0.75rem";
        item.style.cursor = "pointer";
        item.textContent = `@${user.username}`;
        item.onclick = () => {
          input.value = user.username;
          dropdown.innerHTML = "";
          dropdown.classList.add("hidden");
        };
        dropdown.appendChild(item);
      });
    }
    dropdown.classList.remove("hidden");
  }

  input.addEventListener("focus", () => {
    if (!input.value.trim()) {
      showDMSuggestions();
    }
  });

  let debounceTimer = null;

  input.addEventListener("input", () => {
    const q = input.value.trim().replace("@", "");
    clearTimeout(debounceTimer);

    if (!q) {
      showDMSuggestions();
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const res = await authFetch(`/api/auth/search?q=${encodeURIComponent(q)}&onlyContacts=true`);
        if (!res) return;
        const data = await res.json();
        const users = data.users || [];

        dropdown.innerHTML = "";

        if (users.length === 0) {
          dropdown.innerHTML = `<div class="suggestion-no-results" style="padding: 0.5rem; color: var(--text-secondary); font-size: 0.75rem; font-style: italic;">No results</div>`;
        } else {
          users.forEach(user => {
            const item = document.createElement("div");
            item.className = "suggestion-item";
            item.style.padding = "0.4rem 0.6rem";
            item.style.fontSize = "0.75rem";
            item.style.cursor = "pointer";
            item.textContent = `@${user.username}`;
            item.onclick = () => {
              input.value = user.username;
              dropdown.innerHTML = "";
              dropdown.classList.add("hidden");
            };
            dropdown.appendChild(item);
          });
        }
        dropdown.classList.remove("hidden");
      } catch (err) {
        console.error("Autocomplete error:", err);
      }
    }, 250);
  });

  document.addEventListener("click", (e) => {
    if (e.target !== input && e.target !== dropdown && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });
}

async function inviteMemberFromInput() {
  const input = document.getElementById("invite-username-input");
  if (!input) return;
  const username = input.value.trim().replace("@", "");
  if (!username) return;

  try {
    const res = await authFetch(`/api/meetings/${meetingCode}/invite`, {
      method: "POST",
      body: JSON.stringify({ username })
    });

    if (res && res.ok) {
      alert(`User @${username} invited to this meeting call!`);
      input.value = "";
    } else {
      const err = await res.json();
      alert(err.error || "Failed to invite user.");
    }
  } catch (error) {
    console.error("Failed to invite user:", error);
    alert("Error inviting user.");
  }
}

function handleMeetingKicked() {
  alert("You have been kicked from this meeting by the host.");
  leaveMeeting();
}

// --- VIDEO PIN LAYOUT CONTROLS ---

function togglePin(id) {
  if (pinnedParticipantId === id) {
    unpinParticipant();
  } else {
    pinParticipant(id);
  }
}

function pinParticipant(id) {
  pinnedParticipantId = id;

  const grid = document.getElementById("video-grid");
  if (!grid) return;

  grid.classList.add("pinned");

  // Ensure strip container exists
  let strip = document.getElementById("meeting-pin-strip");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "meeting-pin-strip";
    strip.className = "meeting-pin-strip";
    grid.appendChild(strip);
  }

  // Update classes and parent elements of all tiles
  const allTiles = document.querySelectorAll(".meeting-video-tile");
  allTiles.forEach(tile => {
    const tileId = tile.id.replace("tile-", "");
    const pinBtn = tile.querySelector(".tile-pin-btn");

    tile.classList.remove("tile-pinned", "tile-pip", "tile-strip");
    if (pinBtn) pinBtn.classList.remove("pinned");

    if (tileId === id) {
      tile.classList.add("tile-pinned");
      if (pinBtn) pinBtn.classList.add("pinned");
      grid.appendChild(tile);
    } else if (tileId === "local") {
      tile.classList.add("tile-pip");
      grid.appendChild(tile);
    } else {
      tile.classList.add("tile-strip");
      strip.appendChild(tile);
    }
  });

  updateVideoGridLayout();
  window.dispatchEvent(new Event("resize"));
}

function unpinParticipant() {
  pinnedParticipantId = null;

  const grid = document.getElementById("video-grid");
  if (!grid) return;

  grid.classList.remove("pinned");

  const strip = document.getElementById("meeting-pin-strip");
  const allTiles = document.querySelectorAll(".meeting-video-tile");
  allTiles.forEach(tile => {
    const pinBtn = tile.querySelector(".tile-pin-btn");
    tile.classList.remove("tile-pinned", "tile-pip", "tile-strip");
    if (pinBtn) pinBtn.classList.remove("pinned");
    grid.appendChild(tile);
  });

  if (strip) {
    strip.remove();
  }

  updateVideoGridLayout();
  window.dispatchEvent(new Event("resize"));
}

// --- WHITEBOARD DISPLAY NESTING ---

function showWhiteboardInTile(id) {
  whiteboardPresenterId = id;
  const tile = document.getElementById(`tile-${id}`);
  const wb = document.getElementById("meeting-whiteboard");
  if (!tile || !wb) return;

  const videoEl = document.getElementById(`video-${id}`);
  const avatarEl = document.getElementById(`avatar-${id}`);
  if (videoEl) videoEl.classList.add("hidden");
  if (avatarEl) avatarEl.classList.add("hidden");

  wb.classList.remove("hidden");
  wb.style.position = "relative";
  wb.style.width = "100%";
  wb.style.height = "100%";
  wb.style.inset = "auto";
  wb.style.zIndex = "auto";
  wb.style.border = "none";
  wb.style.borderRadius = "0";

  tile.appendChild(wb);
  setTimeout(resizeAllCanvases, 50);
}

function hideWhiteboardFromTile() {
  if (!whiteboardPresenterId) return;

  const id = whiteboardPresenterId;
  whiteboardPresenterId = null;

  const tile = document.getElementById(`tile-${id}`);
  const wb = document.getElementById("meeting-whiteboard");

  if (tile) {
    const info = id === "local" ? { video: camEnabled } : participants[id];
    const videoEl = document.getElementById(`video-${id}`);
    const avatarEl = document.getElementById(`avatar-${id}`);
    if (info && videoEl && avatarEl) {
      if (info.video) {
        videoEl.classList.remove("hidden");
        avatarEl.classList.add("hidden");
      } else {
        videoEl.classList.add("hidden");
        avatarEl.classList.remove("hidden");
      }
    }
  }

  if (wb) {
    wb.classList.add("hidden");
    const workspace = document.querySelector(".meeting-video-area") || document.body;
    workspace.appendChild(wb);
  }
}

function showRemoteWhiteboardInTile(presenterId) {
  const tile = document.getElementById(`tile-${presenterId}`);
  if (!tile) return;

  const videoEl = document.getElementById(`video-${presenterId}`);
  const avatarEl = document.getElementById(`avatar-${presenterId}`);
  if (videoEl) videoEl.classList.add("hidden");
  if (avatarEl) avatarEl.classList.add("hidden");

  let remoteWbCanvas = document.getElementById(`whiteboard-canvas-${presenterId}`);
  if (!remoteWbCanvas) {
    remoteWbCanvas = document.createElement("canvas");
    remoteWbCanvas.id = `whiteboard-canvas-${presenterId}`;
    remoteWbCanvas.className = "remote-whiteboard-canvas";
    remoteWbCanvas.style.position = "absolute";
    remoteWbCanvas.style.top = "0";
    remoteWbCanvas.style.left = "0";
    remoteWbCanvas.style.width = "100%";
    remoteWbCanvas.style.height = "100%";
    remoteWbCanvas.style.display = "block";
    remoteWbCanvas.style.background = "#FFFFFF";
    remoteWbCanvas.style.zIndex = "10";
    tile.appendChild(remoteWbCanvas);
  }

  registerRemoteWhiteboard(presenterId, remoteWbCanvas);
  updateVideoGridLayout();
}

function hideRemoteWhiteboardFromTile(presenterId) {
  const tile = document.getElementById(`tile-${presenterId}`);
  const remoteWbCanvas = document.getElementById(`whiteboard-canvas-${presenterId}`);
  if (remoteWbCanvas) {
    remoteWbCanvas.remove();
  }

  unregisterRemoteWhiteboard(presenterId);

  if (tile) {
    const info = participants[presenterId];
    const videoEl = document.getElementById(`video-${presenterId}`);
    const avatarEl = document.getElementById(`avatar-${presenterId}`);
    if (info && videoEl && avatarEl) {
      if (info.video) {
        videoEl.classList.remove("hidden");
        avatarEl.classList.add("hidden");
      } else {
        videoEl.classList.add("hidden");
        avatarEl.classList.remove("hidden");
      }
    }
  }
  updateVideoGridLayout();
}

// Window resize handler to update layout
window.addEventListener("resize", () => {
  updateVideoGridLayout();
});
