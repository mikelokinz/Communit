/**
 * annotation.js — Collaborative screen-share annotations
 * Overlays drawing and shape annotations on active screen share video tiles.
 */

import { getUserInitials } from "./auth.js";

let socket = null;
let meetingCode = null;
let currentUser = null;

let activeScreenShareSocketId = null; // Who is sharing screen
let isAnnotating = false;

let annCanvas = null;
let annCtx = null;
let annToolbar = null;
let textInput = null;

// Drawing states
let currentTool = "pen"; // "pen", "eraser", "text", "line", "rect", "circle"
let currentColor = "#FF4D4D"; // default red for annotations
let currentThickness = 5;

let paths = []; // transient annotation paths
let localRedoStack = [];
let isDrawing = false;
let startPoint = null;
let endPoint = null;
let currentPenPoints = [];

const VIRTUAL_WIDTH = 1000;
const VIRTUAL_HEIGHT = 1000;

export function initAnnotations(socketInstance, code, user) {
  socket = socketInstance;
  meetingCode = code;
  currentUser = user;

  setupSocketListeners();
  createAnnotationUI();
}

/**
 * Dynamically construct the annotation floating toolbar and overlay canvas
 */
function createAnnotationUI() {
  // 1. Create floating annotation toolbar (hidden by default)
  annToolbar = document.createElement("div");
  annToolbar.id = "screen-annotation-toolbar";
  annToolbar.className = "hidden";
  annToolbar.style.cssText = "position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%); background: var(--bg-card); border: 2.5px solid var(--bg-card-hover); border-radius: var(--radius-card); padding: 0.5rem 1rem; display: flex; align-items: center; gap: 0.75rem; z-index: 1000; box-shadow: 0 10px 30px rgba(0,0,0,0.6); font-family: sans-serif;";

  annToolbar.innerHTML = `
    <div style="font-size: 0.7rem; text-transform: uppercase; font-weight: 800; color: var(--accent-green); letter-spacing: 0.05em; border-right: 1px solid #333; padding-right: 0.75rem;"><i class="fa-solid fa-pen" style="margin-right: 0.25rem;"></i> Annotate</div>
    
    <div class="flex items-center gap-1" style="display: flex; align-items: center; gap: 0.25rem;">
      <button id="ann-tool-pen" class="ann-tool-btn active" style="background: var(--accent-green-dim); border: 1.5px solid var(--accent-green); padding: 0.35rem 0.6rem; border-radius: var(--radius-sm); color: #FFF; font-size: 0.8rem; cursor: pointer;"><i class="fa-solid fa-pen" style="margin-right: 0.25rem;"></i> Pen</button>
      <button id="ann-tool-eraser" class="ann-tool-btn" style="background: transparent; border: 1.5px solid transparent; padding: 0.35rem 0.6rem; border-radius: var(--radius-sm); color: #FFF; font-size: 0.8rem; cursor: pointer;"><i class="fa-solid fa-eraser" style="margin-right: 0.25rem;"></i> Eraser</button>
      <button id="ann-tool-text" class="ann-tool-btn" style="background: transparent; border: 1.5px solid transparent; padding: 0.35rem 0.6rem; border-radius: var(--radius-sm); color: #FFF; font-size: 0.8rem; cursor: pointer;"><i class="fa-solid fa-font" style="margin-right: 0.25rem;"></i> Text</button>
      <select id="ann-tool-shape" style="padding: 0.35rem; border-radius: var(--radius-sm); border: 1.5px solid #333; font-size: 0.8rem; background: var(--bg-input); color: #FFF; cursor: pointer;">
        <option value="none">Free Draw</option>
        <option value="line">Line</option>
        <option value="rect">Rectangle</option>
        <option value="circle">Circle</option>
      </select>
    </div>

    <div style="display: flex; align-items: center; gap: 0.5rem; border-left: 1px solid #333; border-right: 1px solid #333; padding: 0 0.75rem;">
      <!-- Colors selection (Red, Green, Yellow, Blue, White) -->
      <div class="ann-color active" data-color="#FF4D4D" style="width: 16px; height: 16px; border-radius: 50%; background: #FF4D4D; cursor: pointer; border: 1.5px solid #FFF;"></div>
      <div class="ann-color" data-color="#4ADE50" style="width: 16px; height: 16px; border-radius: 50%; background: #4ADE50; cursor: pointer; border: 1.5px solid transparent;"></div>
      <div class="ann-color" data-color="#FFD700" style="width: 16px; height: 16px; border-radius: 50%; background: #FFD700; cursor: pointer; border: 1.5px solid transparent;"></div>
      <div class="ann-color" data-color="#007BFF" style="width: 16px; height: 16px; border-radius: 50%; background: #007BFF; cursor: pointer; border: 1.5px solid transparent;"></div>
      <div class="ann-color" data-color="#FFFFFF" style="width: 16px; height: 16px; border-radius: 50%; background: #FFFFFF; cursor: pointer; border: 1.5px solid transparent;"></div>
    </div>

    <div style="display: flex; align-items: center; gap: 0.25rem;">
      <button id="ann-undo" style="background: transparent; border: 1.5px solid #333; padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); color: #FFF; font-size: 0.75rem; cursor: pointer;"><i class="fa-solid fa-rotate-left" style="margin-right: 0.25rem;"></i> Undo</button>
      <button id="ann-clear" style="background: var(--text-danger); border: none; padding: 0.35rem 0.6rem; border-radius: var(--radius-sm); color: #FFF; font-size: 0.75rem; font-weight: bold; cursor: pointer;"><i class="fa-solid fa-trash" style="margin-right: 0.25rem;"></i> Clear</button>
    </div>
  `;

  document.body.appendChild(annToolbar);

  // 2. Create transparent overlay canvas
  annCanvas = document.createElement("canvas");
  annCanvas.id = "screen-annotation-canvas";
  annCanvas.className = "hidden";
  annCanvas.style.cssText = "pointer-events: auto; z-index: 900; background: transparent; cursor: crosshair;";

  document.body.appendChild(annCanvas);
  annCtx = annCanvas.getContext("2d");

  // 3. Create text input overlay
  textInput = document.createElement("input");
  textInput.type = "text";
  textInput.id = "ann-text-input";
  textInput.className = "hidden";
  textInput.style.cssText = "position: absolute; border: 1.5px dashed var(--accent-green); outline: none; background: transparent; color: #FF4D4D; font-family: sans-serif; font-size: 16px; padding: 2px 4px; z-index: 950; font-weight: bold;";
  document.body.appendChild(textInput);

  // Setup toolbar interactions
  setupToolbarEvents();
}

/**
 * Handle mounting / scaling overlay canvas on top of active video tile
 */
function positionCanvasOnVideo() {
  if (!activeScreenShareSocketId) return;

  const isLocal = activeScreenShareSocketId === "local";
  const videoId = isLocal ? "video-local" : `video-${activeScreenShareSocketId}`;
  const videoEl = document.getElementById(videoId);

  if (!videoEl || !isAnnotating) {
    hideAnnotationCanvas();
    return;
  }

  const rect = videoEl.getBoundingClientRect();
  annCanvas.style.position = "absolute";
  annCanvas.style.left = `${rect.left + window.scrollX}px`;
  annCanvas.style.top = `${rect.top + window.scrollY}px`;
  annCanvas.style.width = `${rect.width}px`;
  annCanvas.style.height = `${rect.height}px`;

  annCanvas.width = rect.width;
  annCanvas.height = rect.height;

  annCanvas.classList.remove("hidden");
  drawAll();
}

function hideAnnotationCanvas() {
  annCanvas.classList.add("hidden");
  if (textInput) textInput.classList.add("hidden");
}

function resizeObserverLoop() {
  if (isAnnotating && activeScreenShareSocketId) {
    positionCanvasOnVideo();
    requestAnimationFrame(resizeObserverLoop);
  }
}

/**
 * Toggle active annotation overlays
 */
export function toggleScreenAnnotations() {
  if (!activeScreenShareSocketId) {
    alert("No active screen sharing to annotate.");
    return;
  }

  isAnnotating = !isAnnotating;

  const toggleBtn = document.getElementById("btn-annotate-screen");
  if (toggleBtn) {
    toggleBtn.classList.toggle("active", isAnnotating);
    if (isAnnotating) {
      toggleBtn.style.background = "var(--accent-green)";
      toggleBtn.style.color = "#000";
    } else {
      toggleBtn.style.background = "";
      toggleBtn.style.color = "";
    }
  }

  if (isAnnotating) {
    annToolbar.classList.remove("hidden");
    positionCanvasOnVideo();
    setupCanvasEvents();
    // Start layout observer loop
    requestAnimationFrame(resizeObserverLoop);
  } else {
    annToolbar.classList.add("hidden");
    hideAnnotationCanvas();
  }
}

/**
 * Coordinate Mapping (normalized 1000x1000)
 */
function toVirtualX(clientX) {
  const rect = annCanvas.getBoundingClientRect();
  return ((clientX - rect.left) / rect.width) * VIRTUAL_WIDTH;
}

function toVirtualY(clientY) {
  const rect = annCanvas.getBoundingClientRect();
  return ((clientY - rect.top) / rect.height) * VIRTUAL_HEIGHT;
}

function toRealX(virtualX) {
  const rect = annCanvas.getBoundingClientRect();
  return (virtualX / VIRTUAL_WIDTH) * rect.width;
}

function toRealY(virtualY) {
  const rect = annCanvas.getBoundingClientRect();
  return (virtualY / VIRTUAL_HEIGHT) * rect.height;
}

/**
 * Rendering annotations
 */
function drawAll() {
  annCtx.clearRect(0, 0, annCanvas.width, annCanvas.height);

  paths.forEach(el => {
    drawElement(el);
  });

  if (isDrawing) {
    annCtx.save();
    annCtx.lineWidth = currentThickness * (annCanvas.width / VIRTUAL_WIDTH);
    annCtx.lineCap = "round";
    annCtx.lineJoin = "round";

    if (currentTool === "pen") {
      annCtx.strokeStyle = currentColor;
      annCtx.beginPath();
      currentPenPoints.forEach((pt, idx) => {
        const rx = toRealX(pt.x);
        const ry = toRealY(pt.y);
        if (idx === 0) annCtx.moveTo(rx, ry);
        else annCtx.lineTo(rx, ry);
      });
      annCtx.stroke();
    } else if (currentTool === "eraser") {
      // For annotations overlay, eraser clears the transparent canvas (draws clear rect / destination-out)
      annCtx.strokeStyle = "rgba(0,0,0,1)";
      annCtx.globalCompositeOperation = "destination-out";
      annCtx.beginPath();
      currentPenPoints.forEach((pt, idx) => {
        const rx = toRealX(pt.x);
        const ry = toRealY(pt.y);
        if (idx === 0) annCtx.moveTo(rx, ry);
        else annCtx.lineTo(rx, ry);
      });
      annCtx.stroke();
    } else if (currentTool === "line" && startPoint && endPoint) {
      annCtx.strokeStyle = currentColor;
      annCtx.beginPath();
      annCtx.moveTo(toRealX(startPoint.x), toRealY(startPoint.y));
      annCtx.lineTo(toRealX(endPoint.x), toRealY(endPoint.y));
      annCtx.stroke();
    } else if (currentTool === "rect" && startPoint && endPoint) {
      annCtx.strokeStyle = currentColor;
      const rx1 = toRealX(startPoint.x);
      const ry1 = toRealY(startPoint.y);
      const rx2 = toRealX(endPoint.x);
      const ry2 = toRealY(endPoint.y);
      annCtx.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
    } else if (currentTool === "circle" && startPoint && endPoint) {
      annCtx.strokeStyle = currentColor;
      const rx1 = toRealX(startPoint.x);
      const ry1 = toRealY(startPoint.y);
      const rx2 = toRealX(endPoint.x);
      const ry2 = toRealY(endPoint.y);
      const r = Math.sqrt(Math.pow(rx2 - rx1, 2) + Math.pow(ry2 - ry1, 2));
      annCtx.beginPath();
      annCtx.arc(rx1, ry1, r, 0, 2 * Math.PI);
      annCtx.stroke();
    }
    annCtx.restore();
  }
}

function drawElement(el) {
  annCtx.save();
  annCtx.lineWidth = (el.thickness || 5) * (annCanvas.width / VIRTUAL_WIDTH);
  annCtx.lineCap = "round";
  annCtx.lineJoin = "round";

  if (el.type === "pen") {
    annCtx.strokeStyle = el.color;
    annCtx.beginPath();
    el.points.forEach((pt, idx) => {
      const rx = toRealX(pt.x);
      const ry = toRealY(pt.y);
      if (idx === 0) annCtx.moveTo(rx, ry);
      else annCtx.lineTo(rx, ry);
    });
    annCtx.stroke();
  } else if (el.type === "eraser") {
    // Eraser transparency composite
    annCtx.strokeStyle = "rgba(0,0,0,1)";
    annCtx.globalCompositeOperation = "destination-out";
    annCtx.beginPath();
    el.points.forEach((pt, idx) => {
      const rx = toRealX(pt.x);
      const ry = toRealY(pt.y);
      if (idx === 0) annCtx.moveTo(rx, ry);
      else annCtx.lineTo(rx, ry);
    });
    annCtx.stroke();
  } else if (el.type === "line") {
    annCtx.strokeStyle = el.color;
    annCtx.beginPath();
    annCtx.moveTo(toRealX(el.start.x), toRealY(el.start.y));
    annCtx.lineTo(toRealX(el.end.x), toRealY(el.end.y));
    annCtx.stroke();
  } else if (el.type === "rect") {
    annCtx.strokeStyle = el.color;
    const rx1 = toRealX(el.start.x);
    const ry1 = toRealY(el.start.y);
    const rx2 = toRealX(el.end.x);
    const ry2 = toRealY(el.end.y);
    annCtx.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
  } else if (el.type === "circle") {
    annCtx.strokeStyle = el.color;
    const rx = toRealX(el.start.x);
    const ry = toRealY(el.start.y);
    const rx2 = toRealX(el.end.x);
    const ry2 = toRealY(el.end.y);
    const r = Math.sqrt(Math.pow(rx2 - rx, 2) + Math.pow(ry2 - ry, 2));
    annCtx.beginPath();
    annCtx.arc(rx, ry, r, 0, 2 * Math.PI);
    annCtx.stroke();
  } else if (el.type === "text") {
    annCtx.fillStyle = el.color;
    const size = (el.thickness * 4) + 12;
    annCtx.font = `bold ${size * (annCanvas.width / VIRTUAL_WIDTH)}px sans-serif`;
    annCtx.textBaseline = "top";
    annCtx.fillText(el.text, toRealX(el.x), toRealY(el.y));
  }
  annCtx.restore();
}

/**
 * Annotation events drawing handlers
 */
function setupCanvasEvents() {
  // Clear any old event listeners
  const newCanvas = annCanvas.cloneNode(true);
  annCanvas.parentNode.replaceChild(newCanvas, annCanvas);
  annCanvas = newCanvas;
  annCtx = annCanvas.getContext("2d");

  annCanvas.addEventListener("mousedown", handleStart);
  annCanvas.addEventListener("mousemove", handleMove);
  annCanvas.addEventListener("mouseup", handleEnd);
  annCanvas.addEventListener("mouseleave", handleEnd);

  // Touch handlers
  annCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      handleStart({ clientX: t.clientX, clientY: t.clientY });
    }
  });
  annCanvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      handleMove({ clientX: t.clientX, clientY: t.clientY });
    }
  });
  annCanvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    handleEnd();
  });
}

function handleStart(e) {
  const vx = toVirtualX(e.clientX);
  const vy = toVirtualY(e.clientY);

  isDrawing = true;
  startPoint = { x: vx, y: vy };
  endPoint = { x: vx, y: vy };

  if (currentTool === "text") {
    if (e.preventDefault) e.preventDefault();
    isDrawing = false;
    showTextInputOverlay(e.clientX, e.clientY, vx, vy);
  } else if (currentTool === "pen" || currentTool === "eraser") {
    currentPenPoints = [{ x: vx, y: vy }];
  }

  drawAll();
}

function handleMove(e) {
  if (!isDrawing) return;

  const vx = toVirtualX(e.clientX);
  const vy = toVirtualY(e.clientY);
  endPoint = { x: vx, y: vy };

  if (currentTool === "pen" || currentTool === "eraser") {
    currentPenPoints.push({ x: vx, y: vy });
  }

  drawAll();
}

function handleEnd() {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentTool === "pen" || currentTool === "eraser") {
    if (currentPenPoints.length > 1) {
      const el = {
        type: currentTool,
        id: Math.random().toString(36).substring(2, 9),
        points: currentPenPoints,
        color: currentTool === "pen" ? currentColor : "transparent",
        thickness: currentThickness
      };
      paths.push(el);
      localRedoStack = [];
      socket.emit("ann-draw", { meetingCode, path: el });
    }
    currentPenPoints = [];
  } else if (["line", "rect", "circle"].includes(currentTool) && startPoint && endPoint) {
    const d = Math.sqrt(Math.pow(endPoint.x - startPoint.x, 2) + Math.pow(endPoint.y - startPoint.y, 2));
    if (d > 2) {
      const el = {
        type: currentTool,
        id: Math.random().toString(36).substring(2, 9),
        start: startPoint,
        end: endPoint,
        color: currentColor,
        thickness: currentThickness
      };
      paths.push(el);
      localRedoStack = [];
      socket.emit("ann-draw", { meetingCode, path: el });
    }
    startPoint = null;
    endPoint = null;
  }

  drawAll();
}

function showTextInputOverlay(clientX, clientY, vx, vy) {
  textInput.style.left = `${clientX}px`;
  textInput.style.top = `${clientY}px`;
  textInput.style.color = currentColor;
  
  const size = (currentThickness * 4) + 12;
  textInput.style.fontSize = `${size}px`;
  
  textInput.classList.remove("hidden");
  textInput.value = "";
  setTimeout(() => {
    textInput.focus();
  }, 0);

  textInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      saveTextInput(vx, vy);
    } else if (e.key === "Escape") {
      textInput.value = "";
      textInput.classList.add("hidden");
      textInput.onkeydown = null;
      textInput.onblur = null;
    }
  };

  textInput.onblur = () => {
    saveTextInput(vx, vy);
  };
}

function saveTextInput(vx, vy) {
  const val = textInput.value.trim();
  textInput.value = "";
  textInput.classList.add("hidden");
  textInput.onkeydown = null;
  textInput.onblur = null;

  if (val) {
    const el = {
      type: "text",
      id: Math.random().toString(36).substring(2, 9),
      x: vx,
      y: vy,
      text: val,
      color: currentColor,
      thickness: currentThickness
    };
    paths.push(el);
    localRedoStack = [];
    socket.emit("ann-draw", { meetingCode, path: el });
    drawAll();
  }
}

/**
 * Setup Annotation Toolbar Events
 */
function setupToolbarEvents() {
  const penBtn = document.getElementById("ann-tool-pen");
  const eraserBtn = document.getElementById("ann-tool-eraser");
  const textBtn = document.getElementById("ann-tool-text");
  const shapeSelect = document.getElementById("ann-tool-shape");

  const setAnnBtnClass = (activeBtn) => {
    [penBtn, eraserBtn, textBtn].forEach(btn => {
      if (btn) {
        btn.classList.toggle("active", btn === activeBtn);
        btn.style.background = btn === activeBtn ? "var(--accent-green-dim)" : "transparent";
        btn.style.borderColor = btn === activeBtn ? "var(--accent-green)" : "transparent";
      }
    });
  };

  if (penBtn) {
    penBtn.onclick = () => {
      currentTool = "pen";
      if (shapeSelect) shapeSelect.value = "none";
      setAnnBtnClass(penBtn);
    };
  }

  if (eraserBtn) {
    eraserBtn.onclick = () => {
      currentTool = "eraser";
      if (shapeSelect) shapeSelect.value = "none";
      setAnnBtnClass(eraserBtn);
    };
  }

  if (textBtn) {
    textBtn.onclick = () => {
      currentTool = "text";
      if (shapeSelect) shapeSelect.value = "none";
      setAnnBtnClass(textBtn);
    };
  }

  if (shapeSelect) {
    shapeSelect.onchange = (e) => {
      if (e.target.value !== "none") {
        currentTool = e.target.value;
        setAnnBtnClass(null);
      } else {
        if (penBtn) penBtn.click();
      }
    };
  }

  // Color selection
  const colors = document.querySelectorAll(".ann-color");
  colors.forEach(swatch => {
    swatch.onclick = () => {
      colors.forEach(s => {
        s.classList.remove("active");
        s.style.borderColor = "transparent";
      });
      swatch.classList.add("active");
      swatch.style.borderColor = "#FFF";
      currentColor = swatch.dataset.color;
    };
  });

  // Undo Action
  const undoBtn = document.getElementById("ann-undo");
  if (undoBtn) {
    undoBtn.onclick = () => {
      if (paths.length > 0) {
        const undone = paths.pop();
        socket.emit("ann-undo", { meetingCode, elementId: undone.id });
        drawAll();
      }
    };
  }

  // Clear Action
  const clearBtn = document.getElementById("ann-clear");
  if (clearBtn) {
    clearBtn.onclick = () => {
      paths = [];
      socket.emit("ann-clear", { meetingCode });
      drawAll();
    };
  }
}

/**
 * Socket.io Annotation Listeners
 */
function setupSocketListeners() {
  if (!socket) return;

  socket.on("meeting-screen-share-toggled", ({ socketId, sharing }) => {
    console.log(`[Annotation] Screen share toggled: ${socketId} -> sharing: ${sharing}`);
    
    // Add an Annotate button to meeting toolbar if any screen is shared
    const toggleBtn = document.getElementById("btn-annotate-screen");
    
    if (sharing) {
      activeScreenShareSocketId = socketId;
      if (toggleBtn) toggleBtn.classList.remove("hidden");
    } else {
      if (activeScreenShareSocketId === socketId) {
        activeScreenShareSocketId = null;
        isAnnotating = false;
        paths = [];
        if (toggleBtn) {
          toggleBtn.classList.add("hidden");
          toggleBtn.classList.remove("active");
          toggleBtn.style.background = "";
          toggleBtn.style.color = "";
        }
        annToolbar.classList.add("hidden");
        hideAnnotationCanvas();
      }
    }
  });

  socket.on("annotation-init", ({ paths: initialPaths }) => {
    paths = initialPaths || [];
    if (isAnnotating) drawAll();
  });

  socket.on("ann-draw", ({ path }) => {
    paths.push(path);
    if (isAnnotating) drawAll();
  });

  socket.on("ann-undo", ({ elementId }) => {
    paths = paths.filter(p => p.id !== elementId);
    if (isAnnotating) drawAll();
  });

  socket.on("ann-clear", () => {
    paths = [];
    if (isAnnotating) drawAll();
  });
}

/**
 * Local helper to register local client starting/stopping screen share
 */
export function setLocalScreenSharingState(sharing) {
  if (sharing) {
    activeScreenShareSocketId = "local";
    const toggleBtn = document.getElementById("btn-annotate-screen");
    if (toggleBtn) toggleBtn.classList.remove("hidden");
  } else {
    if (activeScreenShareSocketId === "local") {
      activeScreenShareSocketId = null;
      isAnnotating = false;
      paths = [];
      const toggleBtn = document.getElementById("btn-annotate-screen");
      if (toggleBtn) {
        toggleBtn.classList.add("hidden");
        toggleBtn.classList.remove("active");
        toggleBtn.style.background = "";
        toggleBtn.style.color = "";
      }
      annToolbar.classList.add("hidden");
      hideAnnotationCanvas();
    }
  }
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
