import { getSocket } from "./socket.js";
import { getCurrentUser } from "./auth.js";

let socket = null;
let roomId = null;
let localStream = null;
let peers = {}; // socketId -> RTCPeerConnection

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

/**
 * Initialize WebRTC functionality for the room
 */
export async function initWebRTC(rId) {
  roomId = rId;
  socket = await getSocket();

  // Setup UI listeners
  const btnVideo = document.getElementById("btn-join-video");
  const btnAudio = document.getElementById("btn-join-audio");
  const btnLeave = document.getElementById("btn-leave-call");

  if (btnVideo) {
    btnVideo.addEventListener("click", () => joinCall(true, true));
  }
  if (btnAudio) {
    btnAudio.addEventListener("click", () => joinCall(false, true));
  }
  if (btnLeave) {
    btnLeave.addEventListener("click", leaveCall);
  }

  // Socket signaling listeners
  socket.on("user-joined-call", handleUserJoinedCall);
  socket.on("user-left-call", handleUserLeftCall);
  socket.on("webrtc-offer", handleOffer);
  socket.on("webrtc-answer", handleAnswer);
  socket.on("webrtc-ice-candidate", handleNewICECandidateMsg);
}

/**
 * Join the call with requested media
 */
async function joinCall(video, audio) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video, audio });
    
    // Show UI changes
    document.getElementById("btn-join-video")?.classList.add("hidden");
    document.getElementById("btn-join-audio")?.classList.add("hidden");
    document.getElementById("btn-leave-call")?.classList.remove("hidden");
    
    const grid = document.getElementById("video-grid");
    if (grid) {
      grid.style.display = "flex";
      grid.classList.remove("hidden");
    }

    addVideoStream("local", localStream, true);

    // Tell others we joined
    socket.emit("join-call", { roomId });
  } catch (error) {
    console.error("[WebRTC] Error accessing media devices:", error);
    alert("Could not access camera or microphone. Please check permissions.");
  }
}

/**
 * Leave the call
 */
function leaveCall() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Close all peer connections
  Object.keys(peers).forEach(socketId => {
    peers[socketId].close();
    delete peers[socketId];
  });

  // UI changes
  document.getElementById("btn-join-video")?.classList.remove("hidden");
  document.getElementById("btn-join-audio")?.classList.remove("hidden");
  document.getElementById("btn-leave-call")?.classList.add("hidden");
  
  const grid = document.getElementById("video-grid");
  if (grid) {
    grid.innerHTML = "";
    grid.style.display = "none";
    grid.classList.add("hidden");
  }

  socket.emit("leave-call", { roomId });
}

/**
 * Handle a new user joining the call (we initiate the offer)
 */
async function handleUserJoinedCall({ socketId, userId, name }) {
  if (!localStream) return; // We are not in the call

  const peerConnection = createPeerConnection(socketId, name);
  peers[socketId] = peerConnection;

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    socket.emit("webrtc-offer", {
      targetSocketId: socketId,
      offer
    });
  } catch (error) {
    console.error("[WebRTC] Error creating offer:", error);
  }
}

/**
 * Handle incoming offer from a peer
 */
async function handleOffer({ fromSocketId, fromUserId, offer }) {
  if (!localStream) return; // We are not in the call

  const peerConnection = createPeerConnection(fromSocketId, "Remote User");
  peers[fromSocketId] = peerConnection;

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit("webrtc-answer", {
      targetSocketId: fromSocketId,
      answer
    });
  } catch (error) {
    console.error("[WebRTC] Error handling offer:", error);
  }
}

/**
 * Handle incoming answer
 */
async function handleAnswer({ fromSocketId, answer }) {
  const peerConnection = peers[fromSocketId];
  if (!peerConnection) return;

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (error) {
    console.error("[WebRTC] Error handling answer:", error);
  }
}

/**
 * Handle incoming ICE candidate
 */
async function handleNewICECandidateMsg({ fromSocketId, candidate }) {
  const peerConnection = peers[fromSocketId];
  if (!peerConnection) return;

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error("[WebRTC] Error adding ICE candidate:", error);
  }
}

/**
 * Handle user leaving the call
 */
function handleUserLeftCall({ socketId }) {
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  removeVideoStream(socketId);
}

/**
 * Create a new RTCPeerConnection and bind events
 */
function createPeerConnection(targetSocketId, name) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-ice-candidate", {
        targetSocketId,
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    addVideoStream(targetSocketId, stream, false);
  };

  return pc;
}

/**
 * Add or update a video stream in the grid
 */
function addVideoStream(id, stream, isLocal) {
  const grid = document.getElementById("video-grid");
  if (!grid) return;

  let videoContainer = document.getElementById(`video-container-${id}`);
  let videoEl = document.getElementById(`video-${id}`);

  if (!videoContainer) {
    videoContainer = document.createElement("div");
    videoContainer.id = `video-container-${id}`;
    videoContainer.className = "video-container";
    videoContainer.style.position = "relative";
    videoContainer.style.width = "300px";
    videoContainer.style.height = "225px";
    videoContainer.style.backgroundColor = "var(--bg-card-hover)";
    videoContainer.style.borderRadius = "var(--radius)";
    videoContainer.style.overflow = "hidden";

    videoEl = document.createElement("video");
    videoEl.id = `video-${id}`;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    if (isLocal) {
      videoEl.muted = true;
      videoEl.style.transform = "scaleX(-1)"; // Mirror local video
    }
    videoEl.style.width = "100%";
    videoEl.style.height = "100%";
    videoEl.style.objectFit = "cover";

    videoContainer.appendChild(videoEl);
    grid.appendChild(videoContainer);
  }

  videoEl.srcObject = stream;
}

/**
 * Remove a video stream from the grid
 */
function removeVideoStream(id) {
  const videoContainer = document.getElementById(`video-container-${id}`);
  if (videoContainer) {
    videoContainer.remove();
  }
}

/**
 * Cleanup on unmount
 */
export function destroyWebRTC() {
  leaveCall();
  if (socket) {
    socket.off("user-joined-call", handleUserJoinedCall);
    socket.off("user-left-call", handleUserLeftCall);
    socket.off("webrtc-offer", handleOffer);
    socket.off("webrtc-answer", handleAnswer);
    socket.off("webrtc-ice-candidate", handleNewICECandidateMsg);
  }
}
