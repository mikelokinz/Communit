/**
 * dashboard.js — Dashboard page logic
 * Handles room listing, room creation, navigation.
 */

import { authGuard, authFetch, getCurrentUser, getUserInitials, logout, getDisplayName } from "./auth.js";
import { initChat, destroyChat } from "./chat.js";
import { getSocket } from "./socket.js";
import { initAudioCallListeners, startAudioCall } from "./audio-call.js";

// Auth guard — redirect if not logged in
if (!authGuard()) {
  throw new Error("Not authenticated");
}

let currentUser = getCurrentUser();
let activeRoomId = null;
let activeRoomSlug = null;
let addedGroupMembers = []; // List of verified usernames to add to the group
let unreadCounts = {}; // roomId -> unread count

// Initialize page
function initDashboard() {
  renderUserInfo();
  loadRooms();
  setupCreateGroupModal();
  setupCreateDMModal();
  setupAutocomplete("room-username-input", "group-username-suggestions");
  setupAutocomplete("dm-username-input", "dm-username-suggestions");
  setupRoomOptionsToggle();
  setupMembersModalClose();
  setupAccountModal();
  setupCreateMeetingModal();
  setupNotifications();
  setupGroupMembersAddForm();
  initAudioCallListeners();
  setupRoomContextMenu();

  // Mobile back button
  const btnChatBack = document.getElementById("btn-chat-back");
  if (btnChatBack) {
    btnChatBack.addEventListener("click", () => {
      closeActiveRoom();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDashboard);
} else {
  initDashboard();
}

/**
 * Render current user info in the nav bar.
 */
function renderUserInfo() {
  const initialsEl = document.getElementById("nav-avatar-initials");

  if (initialsEl && currentUser) {
    initialsEl.textContent = getUserInitials(currentUser);
  }

  const navAvatar = document.getElementById("nav-avatar");
  const avatarDropdown = document.getElementById("avatar-dropdown");
  
  if (navAvatar && avatarDropdown) {
    // Remove existing event listeners by replacing with clone if necessary, 
    // but a standard click handler is fine since this function is only called on init and profile update.
    // If it's called multiple times, let's make sure we only attach once or clean up.
    // Since initials are just text update, we don't have to bind event listeners multiple times.
    if (!navAvatar.dataset.listenerAttached) {
      navAvatar.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        avatarDropdown.classList.toggle("hidden");
      });

      document.addEventListener("click", (e) => {
        if (!navAvatar.contains(e.target) && !avatarDropdown.contains(e.target)) {
          avatarDropdown.classList.add("hidden");
        }
      });
      navAvatar.dataset.listenerAttached = "true";
    }
  }

  const btnAvatarLogout = document.getElementById("btn-avatar-logout");
  if (btnAvatarLogout && !btnAvatarLogout.dataset.listenerAttached) {
    btnAvatarLogout.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      logout();
    });
    btnAvatarLogout.dataset.listenerAttached = "true";
  }

  const btnAvatarAccount = document.getElementById("btn-avatar-account");
  if (btnAvatarAccount && !btnAvatarAccount.dataset.listenerAttached) {
    btnAvatarAccount.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      avatarDropdown.classList.add("hidden");
      openAccountModal();
    });
    btnAvatarAccount.dataset.listenerAttached = "true";
  }
}

/**
 * Fetch and render rooms from the API.
 */
async function loadRooms() {
  const groupGridEl = document.getElementById("room-grid");
  const dmGridEl = document.getElementById("dm-grid");
  const loaderEl = document.getElementById("rooms-loader");
  const emptyEl = document.getElementById("rooms-empty");

  if (!groupGridEl || !dmGridEl) return;

  try {
    const res = await authFetch("/api/rooms");
    if (!res) return;

    const data = await res.json();
    const rooms = data.rooms || [];

    // Sort pinned rooms first, then by updatedAt desc
    rooms.sort((a, b) => {
      const pinA = a.isPinned ? 1 : 0;
      const pinB = b.isPinned ? 1 : 0;
      if (pinA !== pinB) {
        return pinB - pinA;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    // Hide loader
    if (loaderEl) loaderEl.classList.add("hidden");

    if (rooms.length === 0) {
      if (emptyEl) emptyEl.classList.remove("hidden");
      groupGridEl.previousElementSibling.style.display = "none";
      dmGridEl.previousElementSibling.style.display = "none";
      return;
    }

    if (emptyEl) emptyEl.classList.add("hidden");
    groupGridEl.previousElementSibling.style.display = "block";
    dmGridEl.previousElementSibling.style.display = "block";

    groupGridEl.innerHTML = "";
    dmGridEl.innerHTML = "";

    const groups = rooms.filter(r => r.type !== "DIRECT");
    const dms = rooms.filter(r => r.type === "DIRECT");

    groups.forEach(room => {
      groupGridEl.appendChild(createRoomItem(room, false));
    });

    dms.forEach(room => {
      dmGridEl.appendChild(createRoomItem(room, true));
    });

    if (groups.length === 0) groupGridEl.previousElementSibling.style.display = "none";
    if (dms.length === 0) dmGridEl.previousElementSibling.style.display = "none";

    // Update local storage display names mapping
    const displayNames = {};
    rooms.forEach(r => {
      r.participants.forEach(p => {
        displayNames[p.userId] = p.user.name;
      });
    });
    localStorage.setItem("communit_display_names", JSON.stringify(displayNames));

    // Populate DM members checklist in Create Group modal
    populateDMMembers(rooms);

    // Auto-select room from URL parameter if it exists
    const params = new URLSearchParams(window.location.search);
    const initialSlug = params.get("room");
    if (initialSlug && rooms.length > 0) {
      const roomToSelect = rooms.find(r => r.slug === initialSlug);
      if (roomToSelect) {
        selectRoom(roomToSelect);
      }
    }

  } catch (error) {
    console.error("[Dashboard] Failed to load rooms:", error);
    if (loaderEl) loaderEl.classList.add("hidden");
  }
}

/**
 * Create a room list item DOM element.
 */
function createRoomItem(room, isDM) {
  const participantCount = room.participants?.length || 0;

  let displayName = escapeHtml(room.name);
  let displayParticipants = (room.participants || []).slice(0, 1);
  
  if (isDM) {
    const otherUser = room.participants.find(p => p.userId !== currentUser.id)?.user;
    if (otherUser) {
      displayName = escapeHtml(otherUser.name || `@${otherUser.username}`);
      displayParticipants = [{ user: otherUser }];
    }
  }

  const item = document.createElement("div");
  item.className = "room-item";
  if (room.isPinned) {
    item.classList.add("room-item--pinned");
  }
  item.dataset.slug = room.slug;
  item.dataset.id = room.id;
  item.onclick = () => {
    selectRoom(room);
  };

  const p = displayParticipants[0];
  const initials = p ? getUserInitials(p.user) : "??";
  const avatarColor = isDM ? "avatar--green" : "avatar--orange";

  // Last Message formatting
  let lastMessageText = "No messages yet";
  if (room.messages && room.messages.length > 0) {
    const lastMsg = room.messages[0];
    const body = lastMsg.body;
    const sender = lastMsg.sender;
    const truncated = body.length > 30 ? body.substring(0, 30) + "..." : body;
    if (!isDM) {
      const senderName = sender.name || `@${sender.username}`;
      const firstName = senderName.startsWith("@") ? senderName : senderName.split(" ")[0];
      lastMessageText = `${firstName}: ${truncated}`;
    } else {
      lastMessageText = truncated;
    }
  }

  const unreadCount = unreadCounts[room.id] || 0;
  const unreadBadgeHtml = unreadCount > 0 
    ? `<span class="badge badge--green unread-badge" style="font-size: 0.65rem; padding: 0.1rem 0.4rem; flex-shrink: 0; margin-left: 0.5rem; font-weight: 800;">${unreadCount}</span>`
    : "";

  // Pin icon
  const pinIconHtml = room.isPinned 
    ? `<span class="room-pin-icon" style="margin-left: 0.5rem; font-size: 0.75rem; color: var(--accent-green); filter: drop-shadow(0 0 2px var(--accent-green));"><i class="fa-solid fa-thumbtack"></i></span>`
    : "";

  // Block icon
  const blockIconHtml = (isDM && room.isBlocked)
    ? `<span class="room-block-icon" style="margin-left: 0.5rem; font-size: 0.75rem; color: var(--text-danger);"><i class="fa-solid fa-ban"></i></span>`
    : "";

  // Three-dots menu button
  const dotsBtnHtml = `
    <button class="room-item-dots-btn" style="background: transparent; color: var(--text-secondary); border: none; padding: 4px 8px; font-size: 1rem; cursor: pointer; transition: var(--transition); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-left: auto; flex-shrink: 0;"><i class="fa-solid fa-ellipsis-vertical"></i></button>
  `;

  item.innerHTML = `
    <div class="avatar avatar--sm ${avatarColor}" style="width: 36px; height: 36px; font-size: 0.8rem; border: none !important; flex-shrink: 0;">${initials}</div>
    <div class="room-item-details">
      <div class="room-item-name" style="display: flex; align-items: center; justify-content: space-between;">
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayName}</span>
        <div style="display: flex; align-items: center; gap: 0.25rem;">
          ${pinIconHtml}
          ${blockIconHtml}
        </div>
      </div>
      <div class="room-item-meta">
        <span>${escapeHtml(lastMessageText)}</span>
        <span>·</span>
        <span>${formatTimeAgo(room.updatedAt)}</span>
      </div>
    </div>
    ${unreadBadgeHtml}
    ${dotsBtnHtml}
  `;

  // Bind dots button click
  const dotsBtn = item.querySelector(".room-item-dots-btn");
  if (dotsBtn) {
    dotsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showRoomContextMenu(room, isDM, dotsBtn);
    });
  }

  return item;
}

/**
 * Select and open a room in the right chat panel.
 */
async function selectRoom(room) {
  if (activeRoomId === room.id) return;

  try {
    // 1. Clean up any previous chat connection
    if (activeRoomId) {
      destroyChat();
    }

    // 2. Set active identifiers
    activeRoomId = room.id;
    activeRoomSlug = room.slug;
    
    // 3. Highlight selected item in the list
    document.querySelectorAll('.room-item').forEach(el => {
      el.classList.remove('active');
      if (el.dataset.id === room.id) {
        el.classList.add('active');
      }
    });

    // 4. Update the URL query string
    history.pushState(null, "", `?room=${room.slug}`);

    // 5. Hide placeholder and show active chat container
    document.getElementById("chat-placeholder").style.display = "none";
    const chatContainer = document.getElementById("active-chat-container");
    chatContainer.classList.remove("hidden");
    chatContainer.style.display = "flex";

    // Toggle mobile layout class
    document.querySelector(".app-container").classList.add("mobile-active-chat");

    // 6. Reset chat UI state
    document.getElementById("active-room-name").textContent = "LOADING...";
    document.getElementById("chat-messages").innerHTML = `
      <div id="chat-loader" class="loader" style="margin: auto;">
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
      </div>
    `;
    
    const dropdown = document.getElementById("room-options-dropdown");
    if (dropdown) {
      dropdown.classList.add("hidden");
      dropdown.innerHTML = "";
    }
    
    // No local Call UI grid setup needed since calls open in new full-screen tabs.

    // 7. Fetch full room details
    const res = await authFetch(`/api/rooms/${room.slug}`);
    if (!res) return;

    const data = await res.json();
    const fullRoom = data.room;

    if (!fullRoom) {
      alert("Room not found or you don't have access.");
      closeActiveRoom();
      return;
    }

    // Update local storage display names mapping with active room participants
    try {
      const map = JSON.parse(localStorage.getItem("communit_display_names") || "{}");
      fullRoom.participants.forEach(p => {
        map[p.userId] = p.user.name;
      });
      localStorage.setItem("communit_display_names", JSON.stringify(map));
    } catch (e) {}

    let displayName = fullRoom.name;
    if (fullRoom.type === "DIRECT") {
      const otherUser = fullRoom.participants.find(p => p.userId !== currentUser.id)?.user;
      if (otherUser) displayName = otherUser.name || otherUser.email || `@${otherUser.username}`;
    }
    document.getElementById("active-room-name").textContent = displayName.toUpperCase();

    // Reset unread count for selected room
    unreadCounts[room.id] = 0;
    updateUnreadBadgeUI(room.id);

    // Setup Call and Audio buttons based on room type (DIRECT vs GROUP)
    const oldCallBtn = document.getElementById("btn-chat-call");
    const oldAudioBtn = document.getElementById("btn-chat-audio");
    
    if (oldCallBtn) {
      const newCallBtn = oldCallBtn.cloneNode(true);
      oldCallBtn.parentNode.replaceChild(newCallBtn, oldCallBtn);

      if (fullRoom.type === "DIRECT") {
        newCallBtn.innerHTML = '<i class="fa-solid fa-video"></i><span class="desktop-only" style="margin-left: 0.25rem;">CALL</span>';
        newCallBtn.className = "btn-pill btn-pill--green btn-pill--sm";
        newCallBtn.title = "Video Call";
        const otherUser = fullRoom.participants.find(p => p.userId !== currentUser.id)?.user;
        newCallBtn.onclick = () => startDirectCall(otherUser);
      } else {
        newCallBtn.innerHTML = '<i class="fa-solid fa-video"></i><span class="desktop-only" style="margin-left: 0.25rem;">MEETING</span>';
        newCallBtn.className = "btn-pill btn-pill--outline btn-pill--sm";
        newCallBtn.title = "Video Meeting";
        newCallBtn.style.color = "var(--accent-orange)";
        newCallBtn.style.borderColor = "var(--accent-orange-dim)";
        const usernames = fullRoom.participants.map(p => p.user.username).filter(uname => uname !== currentUser.username);
        newCallBtn.onclick = () => startGroupMeeting(fullRoom.name, usernames);
      }
    }

    if (oldAudioBtn) {
      const newAudioBtn = oldAudioBtn.cloneNode(true);
      oldAudioBtn.parentNode.replaceChild(newAudioBtn, oldAudioBtn);

      if (fullRoom.type === "DIRECT") {
        newAudioBtn.innerHTML = '<i class="fa-solid fa-microphone"></i><span class="desktop-only" style="margin-left: 0.25rem;">CALL</span>';
        newAudioBtn.className = "btn-pill btn-pill--green btn-pill--sm";
        newAudioBtn.title = "Audio Call";
        const otherUser = fullRoom.participants.find(p => p.userId !== currentUser.id)?.user;
        newAudioBtn.onclick = () => startDirectAudioCall(otherUser);
      } else {
        newAudioBtn.innerHTML = '<i class="fa-solid fa-microphone"></i><span class="desktop-only" style="margin-left: 0.25rem;">GROUP CALL</span>';
        newAudioBtn.className = "btn-pill btn-pill--outline btn-pill--sm";
        newAudioBtn.title = "Group Audio Call";
        newAudioBtn.style.color = "var(--accent-orange)";
        newAudioBtn.style.borderColor = "var(--accent-orange-dim)";
        newAudioBtn.onclick = () => startGroupAudioCall(fullRoom.name);
      }
    }

    // 9. Configure room options dropdown
    const currentUserParticipant = fullRoom.participants.find(p => p.userId === currentUser.id);

    if (dropdown) {
      let optionsHtml = "";

      const isHost = currentUserParticipant && currentUserParticipant.role === "HOST";

      // Members option (Only if room type is GROUP)
      if (fullRoom.type === "GROUP") {
        optionsHtml += `<button class="room-options-item" id="btn-opt-members"><i class="fa-solid fa-users" style="margin-right: 0.5rem; width: 14px;"></i>Members</button>`;
        if (!isHost) {
          optionsHtml += `<button class="room-options-item room-options-item--danger" id="btn-opt-leave"><i class="fa-solid fa-right-from-bracket" style="margin-right: 0.5rem; width: 14px;"></i>Leave Group</button>`;
        }
      }

      // Clear Chat option inside active chat header dropdown
      optionsHtml += `<button class="room-options-item" id="btn-opt-clear"><i class="fa-solid fa-broom" style="margin-right: 0.5rem; width: 14px;"></i>Clear Chat</button>`;

      // Delete option (If user is HOST)
      if (isHost) {
        const deleteText = fullRoom.type === "DIRECT" ? "Delete Chat" : "Delete Group";
        optionsHtml += `<button class="room-options-item room-options-item--danger" id="btn-opt-delete"><i class="fa-solid fa-trash" style="margin-right: 0.5rem; width: 14px;"></i>${deleteText}</button>`;
      }

      dropdown.innerHTML = optionsHtml;

      // Click handler for Clear Chat inside chat header dropdown
      const optClearBtn = document.getElementById("btn-opt-clear");
      if (optClearBtn) {
        optClearBtn.addEventListener("click", async () => {
          dropdown.classList.add("hidden");
          if (confirm("Are you sure you want to clear this chat history? This will delete all messages for everyone in this room.")) {
            try {
              const clearRes = await authFetch(`/api/rooms/${fullRoom.id}/messages`, {
                method: "DELETE"
              });
              if (clearRes && clearRes.ok) {
                document.getElementById("chat-messages").innerHTML = "";
              } else {
                const errData = await clearRes.json();
                alert(errData.error || "Failed to clear chat.");
              }
            } catch (err) {
              console.error("Failed to clear chat:", err);
              alert("Failed to clear chat.");
            }
          }
        });
      }

      // Click handler for Members
      const optMembersBtn = document.getElementById("btn-opt-members");
      if (optMembersBtn) {
        optMembersBtn.addEventListener("click", () => {
          dropdown.classList.add("hidden");
          const membersModal = document.getElementById("group-members-modal");
          if (membersModal) {
            renderGroupMembers(fullRoom.participants);
            membersModal.classList.add("active");
          }
        });
      }

      // Click handler for Delete
      const optDeleteBtn = document.getElementById("btn-opt-delete");
      if (optDeleteBtn) {
        optDeleteBtn.addEventListener("click", async () => {
          dropdown.classList.add("hidden");
          const confirmMsg = fullRoom.type === "DIRECT"
            ? "Are you sure you want to delete this direct message? This will delete the entire chat history for both participants."
            : "Are you sure you want to delete this group? This will delete the group and all its message history for all members.";
          
          if (confirm(confirmMsg)) {
            try {
              const deleteRes = await authFetch(`/api/rooms/${fullRoom.id}`, {
                method: "DELETE"
              });
              if (deleteRes && deleteRes.ok) {
                closeActiveRoom();
                loadRooms();
              } else {
                const errData = await deleteRes.json();
                alert(errData.error || "Failed to delete room.");
              }
            } catch (err) {
              console.error("Failed to delete room:", err);
              alert("Failed to delete room.");
            }
          }
        });
      }

      // Click handler for Leave Group
      const optLeaveBtn = document.getElementById("btn-opt-leave");
      if (optLeaveBtn) {
        optLeaveBtn.addEventListener("click", async () => {
          dropdown.classList.add("hidden");
          if (confirm("Are you sure you want to leave this group?")) {
            try {
              const leaveRes = await authFetch(`/api/rooms/${fullRoom.slug}/leave`, {
                method: "POST"
              });
              if (leaveRes && leaveRes.ok) {
                closeActiveRoom();
                loadRooms();
              } else {
                const errData = await leaveRes.json();
                alert(errData.error || "Failed to leave group.");
              }
            } catch (err) {
              console.error("Failed to leave group:", err);
              alert("Failed to leave group.");
            }
          }
        });
      }
    }

    const loader = document.getElementById("chat-loader");
    if (loader) loader.remove();

    // 10. Initialize Socket Chat
    await initChat(room.id, fullRoom.type);

  } catch (error) {
    console.error("[Dashboard] Failed to select room:", error);
  }
}

/**
 * Close active room and return to welcome placeholder.
 */
function closeActiveRoom() {
  destroyChat();
  activeRoomId = null;
  activeRoomSlug = null;
  
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('active'));
  
  history.pushState(null, "", window.location.pathname);
  
  document.getElementById("chat-placeholder").style.display = "flex";
  const chatContainer = document.getElementById("active-chat-container");
  chatContainer.classList.add("hidden");
  chatContainer.style.display = "none";

  // Toggle mobile layout class
  document.querySelector(".app-container").classList.remove("mobile-active-chat");
}

/**
 * Set up the "Create Group" modal.
 */
function setupCreateGroupModal() {
  const openBtn = document.getElementById("create-room-btn");
  const overlay = document.getElementById("create-room-modal");
  const closeBtn = document.getElementById("modal-close-btn");
  const form = document.getElementById("create-room-form");
  const addMemberBtn = document.getElementById("btn-add-group-member");
  const groupUsernameInput = document.getElementById("room-username-input");

  if (!openBtn || !overlay) return;

  openBtn.addEventListener("click", () => {
    overlay.classList.add("active");
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      overlay.classList.remove("active");
    });
  }

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.remove("active");
    }
  });

  // Handle keydown Enter in username input
  if (groupUsernameInput) {
    groupUsernameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        verifyAndAddGroupMember();
      }
    });
  }

  // Handle + button click
  if (addMemberBtn) {
    addMemberBtn.addEventListener("click", (e) => {
      e.preventDefault();
      verifyAndAddGroupMember();
    });
  }

  // Handle form submit
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById("room-name-input");
      
      const name = nameInput?.value?.trim() || "Untitled Group";
      let usernames = [];

      // Get selected members from DM checkboxes
      const checkedBoxes = document.querySelectorAll('input[name="group-members"]:checked');
      checkedBoxes.forEach(cb => {
        usernames.push(cb.value);
      });

      // Add verified members from tags
      usernames.push(...addedGroupMembers);

      if (usernames.length === 0) {
        alert("Please select or add at least one member to create a group.");
        return;
      }

      try {
        const res = await authFetch("/api/rooms", {
          method: "POST",
          body: JSON.stringify({ name, usernames })
        });

        if (!res) return;
        const data = await res.json();

        if (data.room) {
          overlay.classList.remove("active");
          if (nameInput) nameInput.value = "";
          if (groupUsernameInput) groupUsernameInput.value = "";
          addedGroupMembers = [];
          renderGroupAddedMembers();
          
          // Clear checkboxes
          document.querySelectorAll('input[name="group-members"]:checked').forEach(cb => cb.checked = false);

          selectRoom(data.room);
          loadRooms();
        } else if (data.error) {
          alert(data.error);
        }
      } catch (error) {
        console.error("[Dashboard] Failed to create room:", error);
      }
    });
  }
}

/**
 * Set up the "Create DM" modal.
 */
function setupCreateDMModal() {
  const openBtn = document.getElementById("create-dm-btn");
  const overlay = document.getElementById("create-dm-modal");
  const closeBtn = document.getElementById("dm-modal-close-btn");
  const form = document.getElementById("create-dm-form");

  if (!openBtn || !overlay) return;

  openBtn.addEventListener("click", () => {
    overlay.classList.add("active");
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      overlay.classList.remove("active");
    });
  }

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.remove("active");
    }
  });

  // Handle form submit
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById("dm-username-input");
      const username = usernameInput?.value?.trim().replace("@", "");

      if (!username) return;

      try {
        const res = await authFetch("/api/rooms/direct", {
          method: "POST",
          body: JSON.stringify({ username })
        });

        if (!res) return;
        const data = await res.json();

        if (data.room) {
          overlay.classList.remove("active");
          usernameInput.value = "";
          selectRoom(data.room);
          loadRooms();
        } else if (data.error) {
          alert(data.error);
        }
      } catch (error) {
        console.error("[Dashboard] Failed to create DM:", error);
      }
    });
  }
}

/**
 * Join an existing room by slug.
 */
async function joinRoomBySlug() {
  const input = document.getElementById("join-room-input");
  if (!input) return;

  const val = input.value.trim();
  if (!val) return;

  if (val.startsWith("meet-")) {
    window.open(`/meeting.html?code=${val}`, "_blank");
    input.value = "";
    return;
  }

  try {
    const res = await authFetch(`/api/rooms/${val}/join`, { method: "POST" });
    if (!res) return;

    const data = await res.json();
    if (data.room) {
      input.value = "";
      selectRoom(data.room);
      loadRooms();
    } else if (data.error) {
      alert(data.error);
    }
  } catch (error) {
    console.error("[Dashboard] Failed to join room:", error);
  }
}

// Expose globally for inline onclick
window.joinRoomBySlug = joinRoomBySlug;

/**
 * Format a date as a relative time string.
 */
function formatTimeAgo(dateStr) {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;

  return new Date(dateStr).toLocaleDateString();
}

/**
 * Populate DM members list in the Create Group modal.
 */
function populateDMMembers(rooms) {
  const container = document.getElementById("dm-members-list");
  if (!container) return;

  const dms = rooms.filter(r => r.type === "DIRECT");
  container.innerHTML = "";

  if (dms.length === 0) {
    container.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; padding: 0.25rem 0.5rem; display: block;">No direct message contacts found.</span>`;
    return;
  }

  dms.forEach((room, i) => {
    const otherUser = room.participants.find(p => p.userId !== currentUser.id)?.user;
    if (!otherUser) return;

    const displayName = otherUser.name || `@${otherUser.username}`;
    const initials = getUserInitials(otherUser);
    const color = i % 2 === 0 ? "avatar--green" : "avatar--orange";

    const label = document.createElement("label");
    label.className = "dm-member-checkbox-item";
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.gap = "0.75rem";
    label.style.cursor = "pointer";
    label.style.padding = "0.5rem";
    label.style.borderRadius = "var(--radius-sm)";
    label.style.transition = "var(--transition)";

    // Hover effect
    label.addEventListener("mouseenter", () => {
      label.style.background = "var(--bg-card-hover)";
    });
    label.addEventListener("mouseleave", () => {
      label.style.background = "transparent";
    });

    label.innerHTML = `
      <input
        type="checkbox"
        name="group-members"
        value="${otherUser.username}"
        style="accent-color: var(--accent-green); cursor: pointer; width: 1.1rem; height: 1.1rem; flex-shrink: 0;"
      >
      <div class="avatar avatar--sm ${color}" style="font-size: 0.7rem; width: 24px; height: 24px; border: none !important;">${initials}</div>
      <span style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(displayName)} (@${otherUser.username})</span>
    `;

    container.appendChild(label);
  });
}

/**
 * Set up debounced username autocomplete suggestions on an input field.
 */
function setupAutocomplete(inputId, suggestionsId, onlyContacts = false) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(suggestionsId);
  if (!input || !dropdown) return;

  let debounceTimer = null;

  input.addEventListener("input", () => {
    const q = input.value.trim().replace("@", "");
    clearTimeout(debounceTimer);

    if (!q) {
      dropdown.innerHTML = "";
      dropdown.classList.add("hidden");
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const res = await authFetch(`/api/auth/search?q=${encodeURIComponent(q)}&onlyContacts=${onlyContacts}`);
        if (!res) return;
        const data = await res.json();
        const users = data.users || [];

        dropdown.innerHTML = "";

        if (users.length === 0) {
          dropdown.innerHTML = `<div class="suggestion-no-results">No results</div>`;
        } else {
          users.forEach(user => {
            const item = document.createElement("div");
            item.className = "suggestion-item";
            item.textContent = `@${user.username} (${user.name || user.email})`;
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

  // Hide dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (e.target !== input && e.target !== dropdown && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });
}

/**
 * Verify if a username exists and add it to group tag list.
 */
async function verifyAndAddGroupMember() {
  const input = document.getElementById("room-username-input");
  if (!input) return;
  const username = input.value.trim().replace("@", "");
  if (!username) return;

  if (addedGroupMembers.includes(username)) {
    input.value = "";
    return;
  }

  try {
    const res = await authFetch(`/api/auth/verify/${encodeURIComponent(username)}`);
    if (res && res.ok) {
      addedGroupMembers.push(username);
      renderGroupAddedMembers();
      input.value = "";
    } else {
      const err = await res.json();
      alert(err.error || `User @${username} not found in database.`);
    }
  } catch (error) {
    console.error("Verify member error:", error);
    alert("Error verifying username.");
  }
}

/**
 * Render verified tag badges for the group modal.
 */
function renderGroupAddedMembers() {
  const container = document.getElementById("group-added-members");
  if (!container) return;
  container.innerHTML = "";
  
  addedGroupMembers.forEach(username => {
    const tag = document.createElement("span");
    tag.className = "member-tag";
    tag.innerHTML = `
      ${escapeHtml(username)}
      <span class="member-tag-remove" data-username="${username}">✕</span>
    `;
    
    tag.querySelector(".member-tag-remove").onclick = (e) => {
      const u = e.target.dataset.username;
      addedGroupMembers = addedGroupMembers.filter(name => name !== u);
      renderGroupAddedMembers();
    };
    
    container.appendChild(tag);
  });
}

/**
 * Setup room options dropdown toggle
 */
function setupRoomOptionsToggle() {
  const optionsBtn = document.getElementById("btn-room-options");
  const dropdown = document.getElementById("room-options-dropdown");
  if (!optionsBtn || !dropdown) return;

  optionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (e.target !== optionsBtn && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });
}

/**
 * Setup group members modal close controls
 */
function setupMembersModalClose() {
  const modal = document.getElementById("group-members-modal");
  const closeBtn = document.getElementById("members-modal-close-btn");
  if (!modal) return;

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      modal.classList.remove("active");
    });
  }

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.remove("active");
    }
  });
}

/**
 * Render list of group members inside modal
 */
function renderGroupMembers(participants) {
  const container = document.getElementById("group-members-list");
  if (!container) return;
  container.innerHTML = "";
  
  const requesterParticipant = participants.find(p => p.userId === currentUser.id);
  const isRequesterHost = requesterParticipant && requesterParticipant.role === "HOST";

  participants.forEach((p, i) => {
    const user = p.user;
    const initials = getUserInitials(user);
    const color = i % 2 === 0 ? "avatar--green" : "avatar--orange";
    const roleBadge = p.role === "HOST" ? `<span class="badge badge--orange" style="font-size: 0.65rem; padding: 0.1rem 0.35rem; font-weight:700;">HOST</span>` : "";
    const displayName = user.name || `@${user.username}`;
    
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.padding = "0.4rem 0";
    row.style.borderBottom = "1px solid #1A1A1A";
    
    let rightSideHtml = roleBadge;
    if (isRequesterHost && user.id !== currentUser.id) {
      rightSideHtml = `<button class="btn-remove-member" style="background: transparent; color: var(--text-danger); border: 1.5px solid var(--text-danger); border-radius: var(--radius-sm); font-size: 0.65rem; padding: 0.15rem 0.4rem; font-weight: 700; cursor: pointer; transition: var(--transition);" data-userid="${user.id}">REMOVE</button>`;
    }

    row.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        <div class="avatar avatar--sm ${color}" style="font-size: 0.7rem; width: 28px; height: 28px; border: none !important;">${initials}</div>
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 0.85rem; color: var(--text-primary); font-weight: 600;">${escapeHtml(displayName)}</span>
          <span style="font-size: 0.75rem; color: var(--text-secondary);">@${user.username}</span>
        </div>
      </div>
      ${rightSideHtml}
    `;
    
    const removeBtn = row.querySelector(".btn-remove-member");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        if (confirm(`Are you sure you want to remove @${user.username} from the group?`)) {
          try {
            const res = await authFetch(`/api/rooms/${activeRoomSlug}/participants/${user.id}`, {
              method: "DELETE"
            });
            if (res && res.ok) {
              // Reload room details to re-render members
              const detailsRes = await authFetch(`/api/rooms/${activeRoomSlug}`);
              if (detailsRes && detailsRes.ok) {
                const data = await detailsRes.json();
                renderGroupMembers(data.room.participants);
              }
            } else {
              const err = await res.json();
              alert(err.error || "Failed to remove member.");
            }
          } catch (error) {
            console.error("Failed to remove member:", error);
            alert("Failed to remove member.");
          }
        }
      });
    }

    container.appendChild(row);
  });

  // Render the Quick Add DM contacts list inside members modal
  renderQuickAddList(participants);
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function openAccountModal() {
  const modal = document.getElementById("account-modal");
  if (!modal) return;

  // Clear messages
  const errEl = document.getElementById("account-error-msg");
  const successEl = document.getElementById("account-success-msg");
  if (errEl) { errEl.textContent = ""; errEl.classList.remove("visible"); }
  if (successEl) { successEl.textContent = ""; successEl.style.display = "none"; }

  // Pre-populate details
  const nameInput = document.getElementById("account-name");
  const usernameInput = document.getElementById("account-username");
  const emailInput = document.getElementById("account-email");

  if (nameInput) nameInput.value = currentUser.name || "";
  if (usernameInput) usernameInput.value = currentUser.username || "";
  if (emailInput) emailInput.value = currentUser.email || "";

  modal.classList.add("active");
}

function setupAccountModal() {
  const modal = document.getElementById("account-modal");
  const closeBtn = document.getElementById("account-modal-close-btn");
  const profileForm = document.getElementById("account-profile-form");
  const passwordForm = document.getElementById("account-password-form");
  const deleteBtn = document.getElementById("btn-delete-account");

  if (!modal) return;

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      modal.classList.remove("active");
    });
  }

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.remove("active");
    }
  });

  if (profileForm) {
    profileForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("account-error-msg");
      const successEl = document.getElementById("account-success-msg");
      if (errEl) { errEl.textContent = ""; errEl.classList.remove("visible"); }
      if (successEl) { successEl.textContent = ""; successEl.style.display = "none"; }

      const name = document.getElementById("account-name")?.value?.trim();
      const username = document.getElementById("account-username")?.value?.trim();
      const email = document.getElementById("account-email")?.value?.trim();

      try {
        const res = await authFetch("/api/auth/profile", {
          method: "PUT",
          body: JSON.stringify({ name, username, email })
        });

        const data = await res.json();
        if (!res.ok) {
          if (errEl) { errEl.textContent = data.error || "Failed to update profile."; errEl.classList.add("visible"); }
          return;
        }

        // Update token and user in localStorage
        localStorage.setItem("communit_token", data.token);
        localStorage.setItem("communit_user", JSON.stringify(data.user));
        
        // Update local variable
        currentUser = data.user;

        // Re-render UI elements using new details
        renderUserInfo();

        if (successEl) {
          successEl.textContent = "Profile updated successfully.";
          successEl.style.display = "block";
        }
      } catch (err) {
        console.error("Profile update error:", err);
        if (errEl) { errEl.textContent = "An error occurred."; errEl.classList.add("visible"); }
      }
    });
  }

  if (passwordForm) {
    passwordForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("account-error-msg");
      const successEl = document.getElementById("account-success-msg");
      if (errEl) { errEl.textContent = ""; errEl.classList.remove("visible"); }
      if (successEl) { successEl.textContent = ""; successEl.style.display = "none"; }

      const currentPassword = document.getElementById("account-old-password")?.value;
      const newPassword = document.getElementById("account-new-password")?.value;

      try {
        const res = await authFetch("/api/auth/profile/password", {
          method: "PUT",
          body: JSON.stringify({ currentPassword, newPassword })
        });

        const data = await res.json();
        if (!res.ok) {
          if (errEl) { errEl.textContent = data.error || "Failed to update password."; errEl.classList.add("visible"); }
          return;
        }

        // Clear password inputs
        document.getElementById("account-old-password").value = "";
        document.getElementById("account-new-password").value = "";

        if (successEl) {
          successEl.textContent = "Password updated successfully.";
          successEl.style.display = "block";
        }
      } catch (err) {
        console.error("Password update error:", err);
        if (errEl) { errEl.textContent = "An error occurred."; errEl.classList.add("visible"); }
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      const confirmDelete = confirm("CRITICAL WARNING:\n\nAre you sure you want to delete your account? This will permanently delete all your chats, groups, and message history. This action cannot be undone.");
      if (!confirmDelete) return;

      try {
        const res = await authFetch("/api/auth/profile", {
          method: "DELETE"
        });

        if (res && res.ok) {
          localStorage.removeItem("communit_token");
          localStorage.removeItem("communit_user");
          window.location.href = "/login.html";
        } else {
          const data = await res.json();
          alert(data.error || "Failed to delete account.");
        }
      } catch (err) {
        console.error("Delete account error:", err);
        alert("An error occurred while deleting your account.");
      }
    });
  }
}

// --- MEETING & NOTIFICATION LOGIC ---

let addedMeetingMembers = [];

function setupCreateMeetingModal() {
  const openBtn = document.getElementById("create-meeting-btn");
  const overlay = document.getElementById("create-meeting-modal");
  const closeBtn = document.getElementById("meeting-modal-close-btn");
  const form = document.getElementById("create-meeting-form");
  const addMemberBtn = document.getElementById("btn-add-meeting-member");
  const meetingUsernameInput = document.getElementById("meeting-username-input");

  if (!openBtn || !overlay) return;

  openBtn.addEventListener("click", () => {
    overlay.classList.add("active");
    populateMeetingDMMembers();
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      overlay.classList.remove("active");
    });
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.remove("active");
    }
  });

  setupAutocomplete("meeting-username-input", "meeting-username-suggestions", true);

  if (meetingUsernameInput) {
    meetingUsernameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        verifyAndAddMeetingMember();
      }
    });
  }

  if (addMemberBtn) {
    addMemberBtn.addEventListener("click", (e) => {
      e.preventDefault();
      verifyAndAddMeetingMember();
    });
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const titleInput = document.getElementById("meeting-title-input");
      const title = titleInput?.value?.trim() || "Untitled Meeting";

      try {
        // Gather checked DM members
        let allUsernames = [...addedMeetingMembers];
        const checkedBoxes = document.querySelectorAll('input[name="meeting-dm-members"]:checked');
        checkedBoxes.forEach(cb => {
          if (!allUsernames.includes(cb.value)) allUsernames.push(cb.value);
        });

        const res = await authFetch("/api/meetings", {
          method: "POST",
          body: JSON.stringify({ title, usernames: allUsernames })
        });

        if (!res) return;
        const data = await res.json();

        if (data.meeting) {
          overlay.classList.remove("active");
          if (titleInput) titleInput.value = "";
          if (meetingUsernameInput) meetingUsernameInput.value = "";
          addedMeetingMembers = [];
          renderMeetingAddedMembers();

          // Open the meeting page in a new window/tab
          window.open(`/meeting.html?code=${data.meeting.code}`, "_blank");
        } else if (data.error) {
          alert(data.error);
        }
      } catch (error) {
        console.error("[Dashboard] Failed to create meeting:", error);
      }
    });
  }
}

async function verifyAndAddMeetingMember() {
  const input = document.getElementById("meeting-username-input");
  if (!input) return;
  const username = input.value.trim().replace("@", "");
  if (!username) return;

  if (addedMeetingMembers.includes(username)) {
    input.value = "";
    return;
  }

  try {
    const res = await authFetch(`/api/auth/verify/${encodeURIComponent(username)}`);
    if (res && res.ok) {
      addedMeetingMembers.push(username);
      renderMeetingAddedMembers();
      input.value = "";
    } else {
      const err = await res.json();
      alert(err.error || `User @${username} not found in database.`);
    }
  } catch (error) {
    console.error("Verify member error:", error);
    alert("Error verifying username.");
  }
}

function renderMeetingAddedMembers() {
  const container = document.getElementById("meeting-added-members");
  if (!container) return;
  container.innerHTML = "";

  addedMeetingMembers.forEach(username => {
    const tag = document.createElement("span");
    tag.className = "member-tag";
    tag.innerHTML = `
      ${escapeHtml(username)}
      <span class="member-tag-remove" data-username="${username}">✕</span>
    `;

    tag.querySelector(".member-tag-remove").onclick = (e) => {
      const u = e.target.dataset.username;
      addedMeetingMembers = addedMeetingMembers.filter(name => name !== u);
      renderMeetingAddedMembers();
    };

    container.appendChild(tag);
  });
}

async function setupNotifications() {
  const bell = document.getElementById("notification-bell");
  const dropdown = document.getElementById("notification-dropdown");

  if (!bell || !dropdown) return;

  bell.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isHidden = dropdown.classList.contains("hidden");
    if (!isHidden) {
      dropdown.classList.add("hidden");
      markAllNotificationsSeen();
    } else {
      dropdown.classList.remove("hidden");
      markAllNotificationsSeen();
    }
  });

  document.addEventListener("click", async (e) => {
    if (!bell.contains(e.target) && !dropdown.contains(e.target)) {
      if (!dropdown.classList.contains("hidden")) {
        dropdown.classList.add("hidden");
        markAllNotificationsSeen();
      }
    }
  });

  // Load notifications initially
  await loadNotifications();

  // Listen on Socket for new invites
  try {
    const socket = await getSocket();
    socket.on("meeting-invite", (data) => {
      showMeetingInvitePopup(data);
      loadNotifications();
    });

    socket.on("meeting-ended-update", (data) => {
      loadNotifications();
    });

    socket.on("room-created", (data) => {
      loadRooms();
    });

    socket.on("message-notification", (data) => {
      handleIncomingMessageNotification(data);
    });
  } catch (error) {
    console.error("[Dashboard] Socket error in notification setup:", error);
  }
}

async function loadNotifications() {
  try {
    const res = await authFetch("/api/meetings/invites");
    if (!res) return;

    const data = await res.json();
    const invites = data.invites || [];

    renderNotificationsList(invites);
  } catch (error) {
    console.error("[Dashboard] Failed to load invites:", error);
  }
}

function renderNotificationsList(invites) {
  const list = document.getElementById("notification-list");
  const empty = document.getElementById("notification-empty");
  const badge = document.getElementById("notification-badge");

  if (!list || !empty || !badge) return;

  list.innerHTML = "";

  const lastCheckedStr = localStorage.getItem("communit_bell_last_checked") || "1970-01-01T00:00:00.000Z";
  const lastChecked = new Date(lastCheckedStr).getTime();

  // Badge alert counts unseen invites that were created after the user last closed the bell
  const unseenCount = invites.filter(i => {
    return !i.seen && new Date(i.createdAt).getTime() > lastChecked;
  }).length;

  if (invites.length === 0) {
    empty.style.display = "block";
    badge.textContent = "0";
    badge.style.display = "none";
    return;
  }

  empty.style.display = "none";
  if (unseenCount > 0) {
    badge.textContent = unseenCount;
    badge.style.display = "flex";
  } else {
    badge.textContent = "0";
    badge.style.display = "none";
  }

  invites.forEach((invite) => {
    const item = document.createElement("div");
    item.className = "notification-item";

    const hostName = invite.meeting.host.name || invite.meeting.host.username || "Someone";
    const isActive = invite.meeting.isActive;

    if (isActive) {
      item.innerHTML = `
        <div class="notification-item-info">
          <div class="notification-item-title">${escapeHtml(invite.meeting.title)}</div>
          <div class="notification-item-host">Host: ${escapeHtml(hostName)}</div>
          <div class="notification-item-status" style="font-size: 0.75rem; color: var(--accent-green); margin-top: 0.25rem; font-weight: 600;">Ongoing Meeting</div>
        </div>
        <button class="notification-item-join" data-code="${invite.meeting.code}" data-invite-id="${invite.id}">JOIN</button>
      `;

      item.querySelector(".notification-item-join").addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const code = e.target.dataset.code;
        const inviteId = e.target.dataset.inviteId;

        await markInviteSeen(inviteId);
        window.open(`/meeting.html?code=${code}`, "_blank");
        loadNotifications();
      });
    } else {
      item.innerHTML = `
        <div class="notification-item-info" style="opacity: 0.7;">
          <div class="notification-item-title">${escapeHtml(invite.meeting.title)}</div>
          <div class="notification-item-host">Host: ${escapeHtml(hostName)}</div>
          <div class="notification-item-status" style="font-size: 0.75rem; color: var(--text-danger); margin-top: 0.25rem; font-weight: 600;">Missed Meeting</div>
        </div>
        <button class="notification-item-dismiss" data-invite-id="${invite.id}" style="background: transparent; color: var(--text-secondary); border: 1.5px solid var(--text-muted); border-radius: var(--radius-sm); font-size: 0.75rem; padding: 0.35rem 0.75rem; font-weight: 700; cursor: pointer; transition: var(--transition);">DISMISS</button>
      `;

      item.querySelector(".notification-item-dismiss").addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const inviteId = e.target.dataset.inviteId;

        await markInviteSeen(inviteId);
        loadNotifications();
      });
    }

    list.appendChild(item);
  });
}

async function markInviteSeen(inviteId) {
  try {
    await authFetch(`/api/meetings/invites/${inviteId}/seen`, {
      method: "PUT"
    });
  } catch (error) {
    console.error("[Dashboard] Failed to mark invite seen:", error);
  }
}

function markAllNotificationsSeen() {
  localStorage.setItem("communit_bell_last_checked", new Date().toISOString());
  const badge = document.getElementById("notification-badge");
  if (badge) {
    badge.textContent = "0";
    badge.style.display = "none";
  }
  loadNotifications();
}

function showMeetingInvitePopup(data) {
  const popup = document.getElementById("meeting-invite-popup");
  const title = document.getElementById("meeting-invite-popup-title");
  const host = document.getElementById("meeting-invite-popup-host");
  const joinBtn = document.getElementById("meeting-invite-join-btn");
  const laterBtn = document.getElementById("meeting-invite-later-btn");

  if (!popup || !title || !host || !joinBtn || !laterBtn) return;

  title.textContent = data.title;
  host.textContent = `Host: ${data.hostName}`;

  popup.style.display = "block";

  const cleanupPopup = () => {
    popup.style.display = "none";
    const newJoinBtn = joinBtn.cloneNode(true);
    const newLaterBtn = laterBtn.cloneNode(true);
    joinBtn.parentNode.replaceChild(newJoinBtn, joinBtn);
    laterBtn.parentNode.replaceChild(newLaterBtn, laterBtn);
  };

  document.getElementById("meeting-invite-join-btn").addEventListener("click", async () => {
    cleanupPopup();
    
    // Find the invite ID to mark it as seen
    try {
      const res = await authFetch("/api/meetings/invites");
      if (res && res.ok) {
        const info = await res.json();
        const invite = info.invites.find(i => i.meetingId === data.meetingId);
        if (invite) {
          await markInviteSeen(invite.id);
        }
      }
    } catch (err) {
      console.error("[Dashboard] Failed to find/seen invite:", err);
    }

    window.open(`/meeting.html?code=${data.meetingCode}`, "_blank");
    loadNotifications();
  });

  document.getElementById("meeting-invite-later-btn").addEventListener("click", () => {
    cleanupPopup();
    // Do NOT mark as seen, just close the popup so it remains in the bell!
    loadNotifications();
  });
}

// --- ADD GROUP MEMBERS IN MODAL ---

function setupGroupMembersAddForm() {
  const input = document.getElementById("add-group-member-input");
  const submitBtn = document.getElementById("btn-add-group-member-submit");

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addGroupMemberFromInput();
      }
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener("click", (e) => {
      e.preventDefault();
      addGroupMemberFromInput();
    });
  }

  // Setup suggestions autocomplete
  setupAutocomplete("add-group-member-input", "add-group-member-suggestions");
}

async function addGroupMemberFromInput() {
  const input = document.getElementById("add-group-member-input");
  if (!input) return;
  const username = input.value.trim().replace("@", "");
  if (!username) return;

  const success = await addGroupMember(username);
  if (success) {
    input.value = "";
  }
}

async function addGroupMember(username) {
  try {
    const res = await authFetch(`/api/rooms/${activeRoomSlug}/add-member`, {
      method: "POST",
      body: JSON.stringify({ username })
    });

    if (res && res.ok) {
      // Reload room details to re-render members modal
      const detailsRes = await authFetch(`/api/rooms/${activeRoomSlug}`);
      if (detailsRes && detailsRes.ok) {
        const data = await detailsRes.json();
        renderGroupMembers(data.room.participants);
      }
      loadRooms();
      return true;
    } else {
      const err = await res.json();
      alert(err.error || "Failed to add member.");
      return false;
    }
  } catch (error) {
    console.error("Failed to add member:", error);
    alert("Error adding member.");
    return false;
  }
}

async function renderQuickAddList(currentParticipants) {
  const container = document.getElementById("group-members-quick-add");
  if (!container) return;
  container.innerHTML = "";

  try {
    const res = await authFetch("/api/rooms");
    if (!res) return;

    const data = await res.json();
    const rooms = data.rooms || [];
    const dms = rooms.filter(r => r.type === "DIRECT");

    // Get list of user IDs currently in the group
    const participantUserIds = currentParticipants.map(p => p.userId);

    let count = 0;
    dms.forEach((room, i) => {
      const otherUser = room.participants.find(p => p.userId !== currentUser.id)?.user;
      if (!otherUser) return;

      // Skip if they are already in the group
      if (participantUserIds.includes(otherUser.id)) return;

      count++;
      const displayName = otherUser.name || `@${otherUser.username}`;
      const initials = getUserInitials(otherUser);
      const color = i % 2 === 0 ? "avatar--green" : "avatar--orange";

      const item = document.createElement("div");
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.justifyContent = "space-between";
      item.style.padding = "0.3rem 0.5rem";
      item.style.borderRadius = "var(--radius-sm)";
      
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <div class="avatar avatar--sm ${color}" style="font-size: 0.65rem; width: 20px; height: 20px; border: none !important;">${initials}</div>
          <span style="font-size: 0.8rem; color: var(--text-primary); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(displayName)}</span>
        </div>
        <button class="btn-quick-add-member" style="background: var(--accent-green); color: #000; border: none; border-radius: var(--radius-sm); font-size: 0.65rem; padding: 0.15rem 0.4rem; font-weight: 700; cursor: pointer; transition: var(--transition);" data-username="${otherUser.username}">ADD</button>
      `;

      item.querySelector(".btn-quick-add-member").onclick = async (e) => {
        const username = e.target.dataset.username;
        await addGroupMember(username);
      };

      container.appendChild(item);
    });

    if (count === 0) {
      container.innerHTML = `<span class="text-muted" style="font-size: 0.75rem; padding: 0.25rem;">No contacts to add.</span>`;
    }

  } catch (error) {
    console.error("Failed to load quick add list:", error);
    container.innerHTML = `<span class="text-muted" style="font-size: 0.75rem; padding: 0.25rem;">Failed to load contacts.</span>`;
  }
}

// --- CALL DIRECT/MEETING HELPERS ---

async function startDirectCall(otherUser) {
  if (!otherUser) return;
  const title = `Video Call with ${currentUser.name || currentUser.username}`;
  try {
    const res = await authFetch("/api/meetings", {
      method: "POST",
      body: JSON.stringify({ title, usernames: [otherUser.username] })
    });
    if (!res) return;
    const data = await res.json();
    if (data.meeting) {
      window.open(`/meeting.html?code=${data.meeting.code}`, "_blank");
    } else {
      alert(data.error || "Failed to start call.");
    }
  } catch (error) {
    console.error("Start call error:", error);
    alert("Error starting video call.");
  }
}

async function startGroupMeeting(roomName, usernames) {
  const title = `${roomName} Meeting`;
  try {
    const res = await authFetch("/api/meetings", {
      method: "POST",
      body: JSON.stringify({ title, usernames })
    });
    if (!res) return;
    const data = await res.json();
    if (data.meeting) {
      window.open(`/meeting.html?code=${data.meeting.code}`, "_blank");
    } else {
      alert(data.error || "Failed to start meeting.");
    }
  } catch (error) {
    console.error("Start meeting error:", error);
    alert("Error starting group meeting.");
  }
}

function startDirectAudioCall(otherUser) {
  if (!otherUser) return;
  startAudioCall(activeRoomId, otherUser.name || otherUser.username, false);
}

function startGroupAudioCall(roomName) {
  startAudioCall(activeRoomId, roomName, true);
}

function handleIncomingMessageNotification(data) {
  const { roomId, senderName, body, senderId } = data;
  const resolvedSenderName = getDisplayName(senderId, senderName);

  // 1. Update the last message preview text in the sidebar
  const roomEl = document.querySelector(`.room-item[data-id="${roomId}"]`);
  if (roomEl) {
    const metaEl = roomEl.querySelector(".room-item-meta span:first-child");
    if (metaEl) {
      const isDM = roomEl.parentNode.id === "dm-grid";
      const truncated = body.length > 30 ? body.substring(0, 30) + "..." : body;
      metaEl.textContent = isDM ? truncated : `${resolvedSenderName.split(" ")[0]}: ${truncated}`;
    }
  }

  // 2. Increment unread count if not active
  if (roomId !== activeRoomId) {
    unreadCounts[roomId] = (unreadCounts[roomId] || 0) + 1;
    updateUnreadBadgeUI(roomId);

    // 3. Show message popup toast alert if unread count is 10 or less
    if (unreadCounts[roomId] <= 10) {
      showMessageNotificationPopup(resolvedSenderName, body);
    }
  }
}

function updateUnreadBadgeUI(roomId) {
  const roomEl = document.querySelector(`.room-item[data-id="${roomId}"]`);
  if (!roomEl) return;

  let badgeEl = roomEl.querySelector(".unread-badge");
  const count = unreadCounts[roomId] || 0;

  if (count > 0) {
    if (!badgeEl) {
      badgeEl = document.createElement("span");
      badgeEl.className = "badge badge--green unread-badge";
      badgeEl.style.cssText = "font-size: 0.65rem; padding: 0.1rem 0.4rem; flex-shrink: 0; margin-left: 0.5rem; font-weight: 800;";
      
      const partBadge = roomEl.querySelector(".badge--orange");
      if (partBadge) {
        roomEl.insertBefore(badgeEl, partBadge);
      } else {
        roomEl.appendChild(badgeEl);
      }
    }
    badgeEl.textContent = count;
  } else {
    if (badgeEl) {
      badgeEl.remove();
    }
  }
}

function showMessageNotificationPopup(senderName, body) {
  const popup = document.getElementById("message-notification-popup");
  const title = document.getElementById("message-notification-title");
  const bodyEl = document.getElementById("message-notification-body");

  if (!popup || !title || !bodyEl) return;

  title.textContent = senderName;
  bodyEl.textContent = body;

  popup.style.display = "block";

  if (popup.dataset.timeoutId) {
    clearTimeout(parseInt(popup.dataset.timeoutId, 10));
  }

  const timeoutId = setTimeout(() => {
    popup.style.display = "none";
  }, 4000);
  popup.dataset.timeoutId = timeoutId.toString();
}

/**
 * Populate DM members list in the Create Meeting modal.
 */
async function populateMeetingDMMembers() {
  const container = document.getElementById("meeting-dm-members-list");
  if (!container) return;

  try {
    const res = await authFetch("/api/rooms");
    if (!res) return;
    const data = await res.json();
    const rooms = data.rooms || [];
    const dms = rooms.filter(r => r.type === "DIRECT");

    container.innerHTML = "";

    if (dms.length === 0) {
      container.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; padding: 0.25rem 0.5rem; display: block;">No DM contacts found.</span>`;
      return;
    }

    dms.forEach((room, i) => {
      const otherUser = room.participants.find(p => p.userId !== currentUser.id)?.user;
      if (!otherUser) return;

      const displayName = otherUser.name || `@${otherUser.username}`;
      const initials = getUserInitials(otherUser);
      const color = i % 2 === 0 ? "avatar--green" : "avatar--orange";

      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "0.75rem";
      label.style.cursor = "pointer";
      label.style.padding = "0.35rem 0.5rem";
      label.style.borderRadius = "var(--radius-sm)";
      label.style.transition = "var(--transition)";

      label.addEventListener("mouseenter", () => {
        label.style.background = "var(--bg-card-hover)";
      });
      label.addEventListener("mouseleave", () => {
        label.style.background = "transparent";
      });

      label.innerHTML = `
        <input
          type="checkbox"
          name="meeting-dm-members"
          value="${otherUser.username}"
          style="accent-color: var(--accent-green); cursor: pointer; width: 1.1rem; height: 1.1rem; flex-shrink: 0;"
        >
        <div class="avatar avatar--sm ${color}" style="font-size: 0.7rem; width: 24px; height: 24px; border: none !important;">${initials}</div>
        <span style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(displayName)}</span>
      `;

      container.appendChild(label);
    });
  } catch (error) {
    console.error("[Dashboard] Failed to populate meeting DM members:", error);
    container.innerHTML = `<span class="text-muted" style="font-size: 0.85rem;">Failed to load contacts.</span>`;
  }
}

// --- ROOM CONTEXT MENU LOGIC ---

function setupRoomContextMenu() {
  let menu = document.getElementById("room-context-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "room-context-menu";
    menu.className = "room-options-dropdown hidden";
    menu.style.cssText = "position: fixed; background: var(--bg-card); border: 1.5px solid var(--bg-card-hover); border-radius: var(--radius-sm); z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.5); min-width: 140px; display: flex; flex-direction: column; overflow: hidden; margin-top: 0.25rem;";
    document.body.appendChild(menu);

    // Hide context menu when clicking anywhere else
    document.addEventListener("click", (e) => {
      const isDotsBtn = e.target.classList.contains("room-item-dots-btn");
      if (!isDotsBtn && !menu.contains(e.target)) {
        menu.classList.add("hidden");
      }
    });
  }
}

function showRoomContextMenu(room, isDM, button) {
  const menu = document.getElementById("room-context-menu");
  if (!menu) return;

  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 5}px`;
  menu.style.left = `${rect.right - 140 + window.scrollX}px`;
  menu.classList.remove("hidden");

  let html = "";
  const isPinned = room.isPinned;
  const isBlocked = room.isBlocked;

  // Pin/Unpin option
  html += `<button class="room-options-item" id="ctx-opt-pin"><i class="fa-solid fa-thumbtack" style="margin-right: 0.5rem; width: 14px;"></i>${isPinned ? "Unpin Chat" : "Pin Chat"}</button>`;

  // Clear Chat option
  html += `<button class="room-options-item" id="ctx-opt-clear"><i class="fa-solid fa-broom" style="margin-right: 0.5rem; width: 14px;"></i>Clear Chat</button>`;

  if (isDM) {
    // Edit Name option
    html += `<button class="room-options-item" id="ctx-opt-rename"><i class="fa-solid fa-pen" style="margin-right: 0.5rem; width: 14px;"></i>Edit Name</button>`;
    // Block/Unblock option for DM
    html += `<button class="room-options-item ${isBlocked ? "" : "room-options-item--danger"}" id="ctx-opt-block"><i class="fa-solid ${isBlocked ? "fa-lock-open" : "fa-ban"}" style="margin-right: 0.5rem; width: 14px;"></i>${isBlocked ? "Unblock User" : "Block User"}</button>`;
    // Delete Chat option
    html += `<button class="room-options-item room-options-item--danger" id="ctx-opt-delete"><i class="fa-solid fa-trash" style="margin-right: 0.5rem; width: 14px;"></i>Delete Chat</button>`;
  } else {
    // Leave Group / Delete Group for Groups
    const selfParticipant = room.participants.find(p => p.userId === currentUser.id);
    const isHost = selfParticipant && selfParticipant.role === "HOST";

    if (isHost) {
      html += `<button class="room-options-item room-options-item--danger" id="ctx-opt-delete"><i class="fa-solid fa-trash" style="margin-right: 0.5rem; width: 14px;"></i>Delete Group</button>`;
    } else {
      html += `<button class="room-options-item room-options-item--danger" id="ctx-opt-leave"><i class="fa-solid fa-right-from-bracket" style="margin-right: 0.5rem; width: 14px;"></i>Leave Group</button>`;
    }
  }

  menu.innerHTML = html;

  // Click handler for Pin/Unpin
  const optPinBtn = document.getElementById("ctx-opt-pin");
  if (optPinBtn) {
    optPinBtn.addEventListener("click", async () => {
      menu.classList.add("hidden");
      try {
        const pinRes = await authFetch(`/api/rooms/${room.id}/pin`, { method: "PUT" });
        if (pinRes && pinRes.ok) {
          loadRooms();
        } else {
          alert("Failed to pin/unpin chat.");
        }
      } catch (err) {
        console.error(err);
        alert("Failed to pin/unpin chat.");
      }
    });
  }

  // Click handler for Clear Chat
  const optClearBtn = document.getElementById("ctx-opt-clear");
  if (optClearBtn) {
    optClearBtn.addEventListener("click", async () => {
      menu.classList.add("hidden");
      if (confirm("Are you sure you want to clear this chat history? This will delete all messages for everyone in this room.")) {
        try {
          const clearRes = await authFetch(`/api/rooms/${room.id}/messages`, { method: "DELETE" });
          if (clearRes && clearRes.ok) {
            if (activeRoomId === room.id) {
              document.getElementById("chat-messages").innerHTML = "";
            }
          } else {
            alert("Failed to clear chat.");
          }
        } catch (err) {
          console.error(err);
          alert("Failed to clear chat.");
        }
      }
    });
  }

  // Click handler for Rename User
  const optRenameBtn = document.getElementById("ctx-opt-rename");
  if (optRenameBtn) {
    optRenameBtn.addEventListener("click", () => {
      menu.classList.add("hidden");
      const otherParticipant = room.participants.find(p => p.userId !== currentUser.id);
      const otherUser = otherParticipant?.user;
      if (!otherUser) return;

      const currentDisp = getDisplayName(otherUser.id, otherUser.name || `@${otherUser.username}`);
      const newName = prompt(`Enter a new name for ${otherUser.name || otherUser.username}:`, currentDisp);
      if (newName === null) return; // user cancelled

      const trimmedName = newName.trim();
      renameContact(otherUser.id, trimmedName);
    });
  }

  // Click handler for Block/Unblock
  const optBlockBtn = document.getElementById("ctx-opt-block");
  if (optBlockBtn) {
    optBlockBtn.addEventListener("click", async () => {
      menu.classList.add("hidden");
      try {
        const blockRes = await authFetch(`/api/rooms/${room.id}/block`, { method: "PUT" });
        if (blockRes && blockRes.ok) {
          loadRooms();
        } else {
          alert("Failed to block/unblock user.");
        }
      } catch (err) {
        console.error(err);
        alert("Failed to block/unblock user.");
      }
    });
  }

  // Click handler for Delete Room
  const optDeleteBtn = document.getElementById("ctx-opt-delete");
  if (optDeleteBtn) {
    optDeleteBtn.addEventListener("click", async () => {
      menu.classList.add("hidden");
      const confirmMsg = isDM
        ? "Are you sure you want to delete this direct message? This will delete the entire chat history for both participants."
        : "Are you sure you want to delete this group? This will delete the group and all its message history for all members.";
      
      if (confirm(confirmMsg)) {
        try {
          const deleteRes = await authFetch(`/api/rooms/${room.id}`, { method: "DELETE" });
          if (deleteRes && deleteRes.ok) {
            if (activeRoomId === room.id) {
              closeActiveRoom();
            }
            loadRooms();
          } else {
            const errData = await deleteRes.json();
            alert(errData.error || "Failed to delete room.");
          }
        } catch (err) {
          console.error("Failed to delete room:", err);
          alert("Failed to delete room.");
        }
      }
    });
  }

  // Click handler for Leave Group
  const optLeaveBtn = document.getElementById("ctx-opt-leave");
  if (optLeaveBtn) {
    optLeaveBtn.addEventListener("click", async () => {
      menu.classList.add("hidden");
      if (confirm("Are you sure you want to leave this group?")) {
        try {
          const leaveRes = await authFetch(`/api/rooms/${room.slug}/leave`, { method: "POST" });
          if (leaveRes && leaveRes.ok) {
            if (activeRoomId === room.id) {
              closeActiveRoom();
            }
            loadRooms();
          } else {
            const errData = await leaveRes.json();
            alert(errData.error || "Failed to leave group.");
          }
        } catch (err) {
          console.error("Failed to leave group:", err);
          alert("Failed to leave group.");
        }
      }
    });
  }
}

async function renameContact(contactId, customName) {
  try {
    const res = await authFetch("/api/auth/contacts/rename", {
      method: "POST",
      body: JSON.stringify({ contactId, customName })
    });

    if (res && res.ok) {
      await loadRooms();
      if (activeRoomId) {
        const activeRoomItem = document.querySelector(`.room-item.active`);
        if (activeRoomItem && activeRoomItem.dataset.id === activeRoomId) {
          const roomNameSpan = activeRoomItem.querySelector(".room-item-name span");
          if (roomNameSpan) {
            document.getElementById("active-room-name").textContent = roomNameSpan.textContent.toUpperCase();
          }
        }
      }
    } else {
      const err = await res.json();
      alert(err.error || "Failed to rename contact.");
    }
  } catch (error) {
    console.error("Rename contact error:", error);
    alert("Failed to rename contact.");
  }
}

// Listen for real-time room participant changes
document.addEventListener("room-participants-changed", async (e) => {
  await loadRooms();
  // If the active room is the one that changed, and the members modal is open, re-render it
  if (activeRoomId === e.detail.roomId) {
    const membersModal = document.getElementById("group-members-modal");
    if (membersModal && membersModal.classList.contains("active")) {
      try {
        const res = await authFetch(`/api/rooms/${activeRoomSlug}`);
        if (res && res.ok) {
          const data = await res.json();
          renderGroupMembers(data.room.participants);
        }
      } catch (error) {
        console.error("Error updating members modal:", error);
      }
    }
  }
});
