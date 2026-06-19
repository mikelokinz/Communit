import { authFetch } from "./auth.js";

let socket = null;
let meetingCode = null;

let canvas = null;
let ctx = null;
let container = null;
let textInput = null;

// Settings & Tools
let currentTool = "pen"; // "select", "pen", "eraser", "text"
let currentShape = "none"; // "none", "line", "rect", "circle"
let currentColor = "#000000";
let currentThickness = 5;

// Segmented Vector Histories
let allWhiteboards = {}; // presenterId -> { paths: [] }
const remoteCanvases = {}; // presenterId -> { canvas, ctx }

// Elements History (for local whiteboard)
let paths = []; // List of all drawn shapes/texts (normalized 1000x1000 space)
let localRedoStack = [];

function syncLocalPaths() {
  if (socket && socket.id) {
    if (!allWhiteboards[socket.id]) {
      allWhiteboards[socket.id] = { paths: [] };
    }
    allWhiteboards[socket.id].paths = paths;
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Drag State
let isDrawing = false;
let drawingStartPoint = null; // {x, y} virtual
let drawingEndPoint = null; // {x, y} virtual
let currentPenPoints = []; // for active pen drawing

// Selection State
let selectedElementId = null;
let isDraggingSelected = false;
let dragStartPoint = null; // for translating selected items
let selectionBoxStart = null; // for dragging selection rectangle
let selectionBoxEnd = null;
let selectedElementsGroup = []; // Multi-select support

const VIRTUAL_WIDTH = 1000;
const VIRTUAL_HEIGHT = 1000;

export function initWhiteboard(socketInstance, code) {
  socket = socketInstance;
  meetingCode = code;

  canvas = document.getElementById("whiteboard-canvas");
  ctx = canvas.getContext("2d");
  container = document.getElementById("whiteboard-canvas-container");
  textInput = document.getElementById("wb-text-input");

  if (!canvas || !container) return;

  // Window resize observer
  window.addEventListener("resize", resizeAllCanvases);
  setTimeout(resizeAllCanvases, 200);

  // Setup Event Listeners
  setupCanvasEvents();
  setupToolbarEvents();
  setupSocketEvents();
}

/**
 * Coordinate Translators (Scale to 1000x1000 coordinate space)
 */
function toVirtualX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return ((clientX - rect.left) / rect.width) * VIRTUAL_WIDTH;
}

function toVirtualY(clientY) {
  const rect = canvas.getBoundingClientRect();
  return ((clientY - rect.top) / rect.height) * VIRTUAL_HEIGHT;
}

function toRealX(virtualX) {
  const rect = canvas.getBoundingClientRect();
  return (virtualX / VIRTUAL_WIDTH) * rect.width;
}

function toRealY(virtualY) {
  const rect = canvas.getBoundingClientRect();
  return (virtualY / VIRTUAL_HEIGHT) * rect.height;
}

/**
 * Graphics Render Pipeline
 */
function drawAll() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw all persisted vector paths/shapes
  paths.forEach(el => {
    drawElement(el);
  });

  // 2. Draw active transient drawing path
  if (isDrawing) {
    ctx.save();
    ctx.lineWidth = currentThickness * (canvas.width / VIRTUAL_WIDTH);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (currentTool === "pen") {
      ctx.strokeStyle = currentColor;
      ctx.beginPath();
      currentPenPoints.forEach((pt, idx) => {
        const rx = toRealX(pt.x);
        const ry = toRealY(pt.y);
        if (idx === 0) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      });
      ctx.stroke();
    } else if (currentTool === "eraser") {
      ctx.strokeStyle = "#FFFFFF";
      ctx.beginPath();
      currentPenPoints.forEach((pt, idx) => {
        const rx = toRealX(pt.x);
        const ry = toRealY(pt.y);
        if (idx === 0) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      });
      ctx.stroke();
    } else if (currentShape === "line" && drawingStartPoint && drawingEndPoint) {
      ctx.strokeStyle = currentColor;
      ctx.beginPath();
      ctx.moveTo(toRealX(drawingStartPoint.x), toRealY(drawingStartPoint.y));
      ctx.lineTo(toRealX(drawingEndPoint.x), toRealY(drawingEndPoint.y));
      ctx.stroke();
    } else if (currentShape === "rect" && drawingStartPoint && drawingEndPoint) {
      ctx.strokeStyle = currentColor;
      const rx1 = toRealX(drawingStartPoint.x);
      const ry1 = toRealY(drawingStartPoint.y);
      const rx2 = toRealX(drawingEndPoint.x);
      const ry2 = toRealY(drawingEndPoint.y);
      ctx.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
    } else if (currentShape === "circle" && drawingStartPoint && drawingEndPoint) {
      ctx.strokeStyle = currentColor;
      const rx1 = toRealX(drawingStartPoint.x);
      const ry1 = toRealY(drawingStartPoint.y);
      const rx2 = toRealX(drawingEndPoint.x);
      const ry2 = toRealY(drawingEndPoint.y);
      const r = Math.sqrt(Math.pow(rx2 - rx1, 2) + Math.pow(ry2 - ry1, 2));
      ctx.beginPath();
      ctx.arc(rx1, ry1, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3. Draw transient selection rectangle (Lasso bounding box)
  if (currentTool === "select" && selectionBoxStart && selectionBoxEnd) {
    ctx.save();
    ctx.strokeStyle = "rgba(74, 222, 80, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    const rx1 = toRealX(selectionBoxStart.x);
    const ry1 = toRealY(selectionBoxStart.y);
    const rx2 = toRealX(selectionBoxEnd.x);
    const ry2 = toRealY(selectionBoxEnd.y);
    ctx.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
    ctx.fillStyle = "rgba(74, 222, 80, 0.05)";
    ctx.fillRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
    ctx.restore();
  }

  // 4. Draw bounding selections
  if (currentTool === "select") {
    selectedElementsGroup.forEach(id => {
      const el = paths.find(p => p.id === id);
      if (el) drawSelectionBox(el);
    });
  }
}

function drawElement(el) {
  ctx.save();
  ctx.lineWidth = (el.thickness || 5) * (canvas.width / VIRTUAL_WIDTH);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (el.type === "pen") {
    ctx.strokeStyle = el.color;
    ctx.beginPath();
    el.points.forEach((pt, idx) => {
      const rx = toRealX(pt.x);
      const ry = toRealY(pt.y);
      if (idx === 0) ctx.moveTo(rx, ry);
      else ctx.lineTo(rx, ry);
    });
    ctx.stroke();
  } else if (el.type === "eraser") {
    ctx.strokeStyle = "#FFFFFF";
    ctx.beginPath();
    el.points.forEach((pt, idx) => {
      const rx = toRealX(pt.x);
      const ry = toRealY(pt.y);
      if (idx === 0) ctx.moveTo(rx, ry);
      else ctx.lineTo(rx, ry);
    });
    ctx.stroke();
  } else if (el.type === "line") {
    ctx.strokeStyle = el.color;
    ctx.beginPath();
    ctx.moveTo(toRealX(el.start.x), toRealY(el.start.y));
    ctx.lineTo(toRealX(el.end.x), toRealY(el.end.y));
    ctx.stroke();
  } else if (el.type === "rect") {
    ctx.strokeStyle = el.color;
    const rx1 = toRealX(el.start.x);
    const ry1 = toRealY(el.start.y);
    const rx2 = toRealX(el.end.x);
    const ry2 = toRealY(el.end.y);
    ctx.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
  } else if (el.type === "circle") {
    ctx.strokeStyle = el.color;
    const rx = toRealX(el.start.x);
    const ry = toRealY(el.start.y);
    const rx2 = toRealX(el.end.x);
    const ry2 = toRealY(el.end.y);
    const r = Math.sqrt(Math.pow(rx2 - rx, 2) + Math.pow(ry2 - ry, 2));
    ctx.beginPath();
    ctx.arc(rx, ry, r, 0, 2 * Math.PI);
    ctx.stroke();
  } else if (el.type === "text") {
    ctx.fillStyle = el.color;
    const size = (el.thickness * 4) + 12; // compute font size
    ctx.font = `bold ${size * (canvas.width / VIRTUAL_WIDTH)}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(el.text, toRealX(el.x), toRealY(el.y));
  }
  ctx.restore();
}

function drawSelectionBox(el) {
  const box = getElementBoundingBox(el);
  if (!box) return;

  ctx.save();
  ctx.strokeStyle = "#4ADE50";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  
  const rx1 = toRealX(box.x1) - 4;
  const ry1 = toRealY(box.y1) - 4;
  const rx2 = toRealX(box.x2) + 4;
  const ry2 = toRealY(box.y2) + 4;

  ctx.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1);

  // Draw little anchor handles on corners
  ctx.fillStyle = "#4ADE50";
  ctx.fillRect(rx1 - 3, ry1 - 3, 6, 6);
  ctx.fillRect(rx2 - 3, ry1 - 3, 6, 6);
  ctx.fillRect(rx1 - 3, ry2 - 3, 6, 6);
  ctx.fillRect(rx2 - 3, ry2 - 3, 6, 6);
  ctx.restore();
}

/**
 * Bounding Box Calculation
 */
function getElementBoundingBox(el) {
  if (el.type === "pen" || el.type === "eraser") {
    if (el.points.length === 0) return null;
    let x1 = el.points[0].x, x2 = el.points[0].x;
    let y1 = el.points[0].y, y2 = el.points[0].y;
    el.points.forEach(pt => {
      if (pt.x < x1) x1 = pt.x;
      if (pt.x > x2) x2 = pt.x;
      if (pt.y < y1) y1 = pt.y;
      if (pt.y > y2) y2 = pt.y;
    });
    return { x1, y1, x2, y2 };
  } else if (el.type === "line" || el.type === "rect" || el.type === "circle") {
    let x1 = Math.min(el.start.x, el.end.x);
    let x2 = Math.max(el.start.x, el.end.x);
    let y1 = Math.min(el.start.y, el.end.y);
    let y2 = Math.max(el.start.y, el.end.y);
    
    if (el.type === "circle") {
      // Circle bounding box is symmetric around center
      const r = Math.sqrt(Math.pow(el.end.x - el.start.x, 2) + Math.pow(el.end.y - el.start.y, 2));
      x1 = el.start.x - r;
      x2 = el.start.x + r;
      y1 = el.start.y - r;
      y2 = el.start.y + r;
    }
    return { x1, y1, x2, y2 };
  } else if (el.type === "text") {
    const size = (el.thickness * 4) + 12;
    // approximate width based on text length
    const w = el.text.length * (size * 0.6);
    const h = size;
    return { x1: el.x, y1: el.y, x2: el.x + w, y2: el.y + h };
  }
  return null;
}

/**
 * Bounding Box Hit Testing
 */
function hitTestElement(el, x, y) {
  const box = getElementBoundingBox(el);
  if (!box) return false;

  // Click must be inside a bounding box expanded by thickness margin
  const margin = Math.max(el.thickness || 5, 8);
  if (x < box.x1 - margin || x > box.x2 + margin || y < box.y1 - margin || y > box.y2 + margin) {
    return false;
  }

  // Precise Hit Testing based on Type
  if (el.type === "rect" || el.type === "text") {
    // Rect and Text click inside bounding box counts as a hit
    return true;
  } else if (el.type === "circle") {
    // Circle: click inside circle bounds counts as hit
    const r = Math.sqrt(Math.pow(el.end.x - el.start.x, 2) + Math.pow(el.end.y - el.start.y, 2));
    const distToCenter = Math.sqrt(Math.pow(x - el.start.x, 2) + Math.pow(y - el.start.y, 2));
    return distToCenter <= r + margin;
  } else if (el.type === "line") {
    // Distance from point to line segment
    return distToSegment({ x, y }, el.start, el.end) <= margin;
  } else if (el.type === "pen" || el.type === "eraser") {
    // Check distance to all segments in pen track
    for (let i = 0; i < el.points.length - 1; i++) {
      if (distToSegment({ x, y }, el.points[i], el.points[i+1]) <= margin) {
        return true;
      }
    }
  }
  return false;
}

function distToSegment(p, a, b) {
  const A = p.x - a.x;
  const B = p.y - a.y;
  const C = b.x - a.x;
  const D = b.y - a.y;
  
  const dot = A * C + B * D;
  const len_sq = C * C + D * D;
  let param = -1;
  if (len_sq !== 0) param = dot / len_sq;
  
  let xx, yy;
  if (param < 0) {
    xx = a.x;
    yy = a.y;
  } else if (param > 1) {
    xx = b.x;
    yy = b.y;
  } else {
    xx = a.x + param * C;
    yy = a.y + param * D;
  }
  
  const dx = p.x - xx;
  const dy = p.y - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Handle Canvas Draw / Select Gestures
 */
function setupCanvasEvents() {
  canvas.addEventListener("mousedown", handleStart);
  canvas.addEventListener("mousemove", handleMove);
  canvas.addEventListener("mouseup", handleEnd);
  canvas.addEventListener("mouseleave", handleEnd);

  // Mobile touch handlers
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      handleStart({ clientX: t.clientX, clientY: t.clientY });
    }
  });
  canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      handleMove({ clientX: t.clientX, clientY: t.clientY });
    }
  });
  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    handleEnd();
  });
}

function handleStart(e) {
  const vx = toVirtualX(e.clientX);
  const vy = toVirtualY(e.clientY);

  isDrawing = true;
  drawingStartPoint = { x: vx, y: vy };
  drawingEndPoint = { x: vx, y: vy };

  if (currentTool === "select") {
    // 1. Check if clicked inside any selected element to start moving
    let hitSelected = false;
    for (let id of selectedElementsGroup) {
      const el = paths.find(p => p.id === id);
      if (el && hitTestElement(el, vx, vy)) {
        hitSelected = true;
        break;
      }
    }

    if (hitSelected) {
      isDraggingSelected = true;
      dragStartPoint = { x: vx, y: vy };
    } else {
      // 2. Otherwise try single select clicked item
      let hitId = null;
      // Loop reverse to hit top-most drawn element first
      for (let i = paths.length - 1; i >= 0; i--) {
        if (hitTestElement(paths[i], vx, vy)) {
          hitId = paths[i].id;
          break;
        }
      }

      if (hitId) {
        selectedElementsGroup = [hitId];
        isDraggingSelected = true;
        dragStartPoint = { x: vx, y: vy };
        document.getElementById("wb-delete").style.display = "block";
      } else {
        // 3. Clicked empty space: start drag-lasso bounding box selection
        selectedElementsGroup = [];
        selectionBoxStart = { x: vx, y: vy };
        selectionBoxEnd = { x: vx, y: vy };
        document.getElementById("wb-delete").style.display = "none";
      }
    }
  } else if (currentTool === "text") {
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
  drawingEndPoint = { x: vx, y: vy };

  if (currentTool === "select") {
    if (isDraggingSelected && dragStartPoint) {
      const dx = vx - dragStartPoint.x;
      const dy = vy - dragStartPoint.y;

      // Translate all selected elements
      selectedElementsGroup.forEach(id => {
        const el = paths.find(p => p.id === id);
        if (el) {
          translateElement(el, dx, dy);
          // Sync displacement in real-time
          socket.emit("wb-move", { meetingCode, elementId: id, dx, dy });
        }
      });
      syncLocalPaths();
      dragStartPoint = { x: vx, y: vy };
    } else if (selectionBoxStart) {
      selectionBoxEnd = { x: vx, y: vy };
    }
  } else if (currentTool === "pen" || currentTool === "eraser") {
    currentPenPoints.push({ x: vx, y: vy });
  }

  drawAll();
}

function handleEnd() {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentTool === "select") {
    if (selectionBoxStart && selectionBoxEnd) {
      // Find all elements lying inside selection bounding box
      const x1 = Math.min(selectionBoxStart.x, selectionBoxEnd.x);
      const x2 = Math.max(selectionBoxStart.x, selectionBoxEnd.x);
      const y1 = Math.min(selectionBoxStart.y, selectionBoxEnd.y);
      const y2 = Math.max(selectionBoxStart.y, selectionBoxEnd.y);

      selectedElementsGroup = [];
      paths.forEach(el => {
        const box = getElementBoundingBox(el);
        if (box) {
          // If center or bounding bounds lies inside selection rectangle
          const cx = (box.x1 + box.x2) / 2;
          const cy = (box.y1 + box.y2) / 2;
          if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
            selectedElementsGroup.push(el.id);
          }
        }
      });

      selectionBoxStart = null;
      selectionBoxEnd = null;

      if (selectedElementsGroup.length > 0) {
        document.getElementById("wb-delete").style.display = "block";
      }
    }
    isDraggingSelected = false;
    dragStartPoint = null;
  } else if (currentTool === "pen" || currentTool === "eraser") {
    if (currentPenPoints.length > 1) {
      const el = {
        type: currentTool,
        id: Math.random().toString(36).substring(2, 9),
        points: currentPenPoints,
        color: currentTool === "pen" ? currentColor : "#FFFFFF",
        thickness: currentThickness
      };
      paths.push(el);
      syncLocalPaths();
      localRedoStack = [];
      socket.emit("wb-draw", { meetingCode, path: el });
    }
    currentPenPoints = [];
  } else if (currentShape !== "none" && drawingStartPoint && drawingEndPoint) {
    // Calculate distance to verify it's a valid stroke (not just a single click)
    const d = Math.sqrt(Math.pow(drawingEndPoint.x - drawingStartPoint.x, 2) + Math.pow(drawingEndPoint.y - drawingStartPoint.y, 2));
    if (d > 2) {
      const el = {
        type: currentShape,
        id: Math.random().toString(36).substring(2, 9),
        start: drawingStartPoint,
        end: drawingEndPoint,
        color: currentColor,
        thickness: currentThickness
      };
      paths.push(el);
      syncLocalPaths();
      localRedoStack = [];
      socket.emit("wb-draw", { meetingCode, path: el });
    }
    drawingStartPoint = null;
    drawingEndPoint = null;
  }

  drawAll();
}

function translateElement(el, dx, dy) {
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

/**
 * Text Tool Overlay
 */
function showTextInputOverlay(clientX, clientY, vx, vy) {
  textInput.style.left = `${clientX - container.getBoundingClientRect().left}px`;
  textInput.style.top = `${clientY - container.getBoundingClientRect().top}px`;
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
      thickness: currentThickness // font-scale variable
    };
    paths.push(el);
    syncLocalPaths();
    localRedoStack = [];
    socket.emit("wb-draw", { meetingCode, path: el });
    drawAll();
  }
}

/**
 * Toolbar UI Actions
 */
function setupToolbarEvents() {
  // Tools selector
  const toolSelect = document.getElementById("wb-tool-select");
  const toolPen = document.getElementById("wb-tool-pen");
  const toolEraser = document.getElementById("wb-tool-eraser");
  const toolText = document.getElementById("wb-tool-text");
  const toolShape = document.getElementById("wb-tool-shape");

  const setToolClass = (activeBtn) => {
    [toolSelect, toolPen, toolEraser, toolText].forEach(btn => {
      if (btn) {
        btn.classList.toggle("active", btn === activeBtn);
        btn.style.background = btn === activeBtn ? "#EFEFEF" : "transparent";
        btn.style.borderColor = btn === activeBtn ? "#DDD" : "transparent";
      }
    });
  };

  if (toolSelect) {
    toolSelect.onclick = () => {
      currentTool = "select";
      currentShape = "none";
      if (toolShape) toolShape.value = "none";
      setToolClass(toolSelect);
      drawAll();
    };
  }

  if (toolPen) {
    toolPen.onclick = () => {
      currentTool = "pen";
      currentShape = "none";
      if (toolShape) toolShape.value = "none";
      setToolClass(toolPen);
      clearSelection();
    };
  }

  if (toolEraser) {
    toolEraser.onclick = () => {
      currentTool = "eraser";
      currentShape = "none";
      if (toolShape) toolShape.value = "none";
      setToolClass(toolEraser);
      clearSelection();
    };
  }

  if (toolText) {
    toolText.onclick = () => {
      currentTool = "text";
      currentShape = "none";
      if (toolShape) toolShape.value = "none";
      setToolClass(toolText);
      clearSelection();
    };
  }

  if (toolShape) {
    toolShape.onchange = (e) => {
      currentShape = e.target.value;
      if (currentShape !== "none") {
        currentTool = "shape";
        // Remove styling from simple tool buttons
        setToolClass(null);
        clearSelection();
      } else {
        // Fall back to Pen tool
        toolPen.click();
      }
    };
  }

  // Thickness
  const thicknessSelect = document.getElementById("wb-thickness");
  if (thicknessSelect) {
    thicknessSelect.onchange = (e) => {
      currentThickness = parseInt(e.target.value, 10);
    };
  }

  // Colors swatches
  const colorSwatches = document.querySelectorAll(".wb-color-swatch");
  colorSwatches.forEach(swatch => {
    swatch.onclick = (e) => {
      colorSwatches.forEach(s => {
        s.classList.remove("active");
        s.style.boxShadow = "none";
      });
      swatch.classList.add("active");
      swatch.style.boxShadow = `0 0 0 2px ${swatch.dataset.color}`;
      currentColor = swatch.dataset.color;
    };
  });

  // Action: Undo
  const undoBtn = document.getElementById("wb-undo");
  if (undoBtn) {
    undoBtn.onclick = () => {
      if (paths.length > 0) {
        const undone = paths.pop();
        syncLocalPaths();
        localRedoStack.push(undone);
        socket.emit("wb-undo", { meetingCode, elementId: undone.id });
        drawAll();
      }
    };
  }

  // Action: Redo
  const redoBtn = document.getElementById("wb-redo");
  if (redoBtn) {
    redoBtn.onclick = () => {
      if (localRedoStack.length > 0) {
        const redone = localRedoStack.pop();
        paths.push(redone);
        syncLocalPaths();
        socket.emit("wb-redo", { meetingCode, path: redone });
        drawAll();
      }
    };
  }

  // Action: Delete Selected Items
  const deleteBtn = document.getElementById("wb-delete");
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      selectedElementsGroup.forEach(id => {
        paths = paths.filter(p => p.id !== id);
        socket.emit("wb-delete", { meetingCode, elementId: id });
      });
      syncLocalPaths();
      clearSelection();
    };
  }

  // Action: Clear Canvas
  const clearBtn = document.getElementById("wb-clear");
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (confirm("Are you sure you want to clear the whiteboard for everyone?")) {
        paths = [];
        syncLocalPaths();
        localRedoStack = [];
        clearSelection();
        socket.emit("wb-clear", { meetingCode });
        drawAll();
      }
    };
  }

  // Close Whiteboard Button
  const closeBtn = document.getElementById("wb-close");
  const wbToggleBtn = document.getElementById("btn-toggle-whiteboard");
  const wbOverlay = document.getElementById("meeting-whiteboard");
  if (closeBtn && wbOverlay) {
    closeBtn.onclick = () => {
      wbOverlay.classList.add("hidden");
      if (wbToggleBtn) wbToggleBtn.classList.remove("active");
    };
  }

  // Prevent whiteboard events from bubbling to video tile parent and triggering pin layout changes
  if (wbOverlay) {
    wbOverlay.ondblclick = (e) => {
      e.stopPropagation();
    };
    wbOverlay.onclick = (e) => {
      e.stopPropagation();
    };
  }

  // Save (Download) Button
  const saveBtn = document.getElementById("wb-save");
  if (saveBtn) {
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      downloadWhiteboard();
    };
  }

  // Share Button
  const shareBtn = document.getElementById("wb-share");
  if (shareBtn) {
    shareBtn.onclick = (e) => {
      e.stopPropagation();
      openShareModal();
    };
  }

  // Share Modal Close
  const shareCloseBtn = document.getElementById("wb-share-modal-close");
  const shareOverlay = document.getElementById("wb-share-modal");
  if (shareCloseBtn && shareOverlay) {
    shareCloseBtn.onclick = (e) => {
      e.stopPropagation();
      shareOverlay.classList.remove("active");
    };
    shareOverlay.onclick = (e) => {
      e.stopPropagation();
      if (e.target === shareOverlay) {
        shareOverlay.classList.remove("active");
      }
    };
  }

  // Share Modal Send
  const shareSendBtn = document.getElementById("wb-share-send-btn");
  if (shareSendBtn) {
    shareSendBtn.onclick = (e) => {
      e.stopPropagation();
      sendWhiteboardToSelectedDMs();
    };
  }
}

function getCanvasJpegDataUrl() {
  if (!canvas) return null;
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height;
  const exportCtx = exportCanvas.getContext("2d");
  
  // Fill with white background
  exportCtx.fillStyle = "#FFFFFF";
  exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  
  // Draw current canvas content
  exportCtx.drawImage(canvas, 0, 0);
  
  return exportCanvas.toDataURL("image/jpeg", 0.9);
}

function downloadWhiteboard() {
  if (!canvas) return;
  const dataUrl = getCanvasJpegDataUrl();
  if (!dataUrl) return;

  const link = document.createElement("a");
  link.download = `whiteboard-${meetingCode}-${Date.now()}.jpg`;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function openShareModal() {
  const shareOverlay = document.getElementById("wb-share-modal");
  const contactsList = document.getElementById("wb-share-contacts-list");
  if (!shareOverlay || !contactsList) return;

  shareOverlay.classList.add("active");
  contactsList.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; padding: 0.25rem 0.5rem; display: block;">Loading chats...</span>`;

  try {
    const res = await authFetch("/api/rooms");
    if (!res || !res.ok) {
      contactsList.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; padding: 0.25rem 0.5rem; display: block;">Failed to load chats.</span>`;
      return;
    }
    const data = await res.json();
    const rooms = data.rooms || [];

    contactsList.innerHTML = "";
    if (rooms.length === 0) {
      contactsList.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; padding: 0.25rem 0.5rem; display: block;">No active chats found.</span>`;
      return;
    }

    const currentUser = JSON.parse(localStorage.getItem("communit_user") || "{}");

    rooms.forEach((room, i) => {
      let displayName = room.name;
      let isDM = room.type === "DIRECT";
      let initials = "??";
      let typeLabel = "Group";

      if (isDM) {
        const otherUser = room.participants.find(p => p.userId !== currentUser.id)?.user;
        if (otherUser) {
          displayName = otherUser.name || `@${otherUser.username}`;
        }
        typeLabel = "DM";
      }

      if (displayName) {
        const startIdx = DisplayNameInitialsStart(displayName);
        initials = displayName.substring(startIdx, startIdx + 2).toUpperCase();
      }

      const color = isDM ? "avatar--green" : "avatar--orange";

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
          name="wb-share-members"
          value="${room.id}"
          style="accent-color: var(--accent-green); cursor: pointer; width: 1.1rem; height: 1.1rem; flex-shrink: 0;"
        >
        <div class="avatar avatar--sm ${color}" style="font-size: 0.7rem; width: 24px; height: 24px; border: none !important; display: flex; align-items: center; justify-content: center; font-weight: 700;">${initials}</div>
        <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
          <span style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(displayName)}</span>
          <span style="font-size: 0.65rem; color: var(--text-secondary); font-weight: 400;">${typeLabel}</span>
        </div>
      `;
      contactsList.appendChild(label);
    });
  } catch (err) {
    console.error("Failed to load chats for sharing:", err);
    contactsList.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; padding: 0.25rem 0.5rem; display: block;">Failed to load chats.</span>`;
  }
}

function DisplayNameInitialsStart(name) {
  if (name.startsWith("@")) return 1;
  return 0;
}

async function sendWhiteboardToSelectedDMs() {
  const checkboxes = document.querySelectorAll('input[name="wb-share-members"]:checked');
  if (checkboxes.length === 0) {
    alert("Please select at least one DM contact to share.");
    return;
  }

  const shareOverlay = document.getElementById("wb-share-modal");
  const sendBtn = document.getElementById("wb-share-send-btn");
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = "SHARING...";
  }

  try {
    if (!canvas) return;
    const imageData = getCanvasJpegDataUrl();
    if (!imageData) return;

    const res = await authFetch("/api/files/whiteboard", {
      method: "POST",
      body: JSON.stringify({ imageData })
    });

    if (!res || !res.ok) {
      alert("Failed to upload whiteboard image.");
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = "SEND TO CHAT";
      }
      return;
    }

    const fileData = await res.json();
    const fileUrl = fileData.url;
    const sizeBytes = fileData.sizeBytes;

    checkboxes.forEach(cb => {
      const roomId = cb.value;
      socket.emit("send-message", {
        roomId,
        body: "",
        type: "WHITEBOARD",
        fileUrl,
        fileName: "whiteboard.jpg",
        fileMimeType: "image/jpeg",
        fileSizeBytes: sizeBytes
      });
    });

    alert("Whiteboard shared successfully to selected DM(s)!");
    if (shareOverlay) shareOverlay.classList.remove("active");
  } catch (err) {
    console.error("Failed to share whiteboard:", err);
    alert("Error sharing whiteboard.");
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = "SEND TO CHAT";
    }
  }
}

function clearSelection() {
  selectedElementsGroup = [];
  const deleteBtn = document.getElementById("wb-delete");
  if (deleteBtn) deleteBtn.style.display = "none";
  drawAll();
}

function drawRemoteElement(ctx, canvasEl, el) {
  ctx.save();
  ctx.lineWidth = (el.thickness || 5) * (canvasEl.width / VIRTUAL_WIDTH);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (el.type === "pen") {
    ctx.strokeStyle = el.color;
    ctx.beginPath();
    el.points.forEach((pt, idx) => {
      const rx = (pt.x / VIRTUAL_WIDTH) * canvasEl.width;
      const ry = (pt.y / VIRTUAL_HEIGHT) * canvasEl.height;
      if (idx === 0) ctx.moveTo(rx, ry);
      else ctx.lineTo(rx, ry);
    });
    ctx.stroke();
  } else if (el.type === "eraser") {
    ctx.strokeStyle = "#FFFFFF";
    ctx.beginPath();
    el.points.forEach((pt, idx) => {
      const rx = (pt.x / VIRTUAL_WIDTH) * canvasEl.width;
      const ry = (pt.y / VIRTUAL_HEIGHT) * canvasEl.height;
      if (idx === 0) ctx.moveTo(rx, ry);
      else ctx.lineTo(rx, ry);
    });
    ctx.stroke();
  } else if (el.type === "line") {
    ctx.strokeStyle = el.color;
    ctx.beginPath();
    ctx.moveTo((el.start.x / VIRTUAL_WIDTH) * canvasEl.width, (el.start.y / VIRTUAL_HEIGHT) * canvasEl.height);
    ctx.lineTo((el.end.x / VIRTUAL_WIDTH) * canvasEl.width, (el.end.y / VIRTUAL_HEIGHT) * canvasEl.height);
    ctx.stroke();
  } else if (el.type === "rect") {
    ctx.strokeStyle = el.color;
    const rx1 = (el.start.x / VIRTUAL_WIDTH) * canvasEl.width;
    const ry1 = (el.start.y / VIRTUAL_HEIGHT) * canvasEl.height;
    const rx2 = (el.end.x / VIRTUAL_WIDTH) * canvasEl.width;
    const ry2 = (el.end.y / VIRTUAL_HEIGHT) * canvasEl.height;
    ctx.strokeRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
  } else if (el.type === "circle") {
    ctx.strokeStyle = el.color;
    const rx = (el.start.x / VIRTUAL_WIDTH) * canvasEl.width;
    const ry = (el.start.y / VIRTUAL_HEIGHT) * canvasEl.height;
    const rx2 = (el.end.x / VIRTUAL_WIDTH) * canvasEl.width;
    const ry2 = (el.end.y / VIRTUAL_HEIGHT) * canvasEl.height;
    const r = Math.sqrt(Math.pow(rx2 - rx, 2) + Math.pow(ry2 - ry, 2));
    ctx.beginPath();
    ctx.arc(rx, ry, r, 0, 2 * Math.PI);
    ctx.stroke();
  } else if (el.type === "text") {
    ctx.fillStyle = el.color;
    const size = (el.thickness * 4) + 12;
    ctx.font = `bold ${size * (canvasEl.width / VIRTUAL_WIDTH)}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(el.text, (el.x / VIRTUAL_WIDTH) * canvasEl.width, (el.y / VIRTUAL_HEIGHT) * canvasEl.height);
  }
  ctx.restore();
}

function drawRemoteWhiteboard(presenterId) {
  const remote = remoteCanvases[presenterId];
  if (!remote) return;
  const { canvas: c, ctx: cx } = remote;
  cx.clearRect(0, 0, c.width, c.height);
  const wbPaths = (allWhiteboards[presenterId] || {}).paths || [];
  wbPaths.forEach(el => {
    drawRemoteElement(cx, c, el);
  });
}

export function registerRemoteWhiteboard(presenterId, canvasEl) {
  remoteCanvases[presenterId] = {
    canvas: canvasEl,
    ctx: canvasEl.getContext("2d")
  };
  const parent = canvasEl.parentElement;
  if (parent) {
    const rect = parent.getBoundingClientRect();
    canvasEl.width = rect.width;
    canvasEl.height = rect.height;
  }
  drawRemoteWhiteboard(presenterId);
}

export function unregisterRemoteWhiteboard(presenterId) {
  delete remoteCanvases[presenterId];
}

export function resizeAllCanvases() {
  if (canvas && container) {
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    drawAll();
  }
  Object.keys(remoteCanvases).forEach(pid => {
    const remote = remoteCanvases[pid];
    if (remote) {
      const parent = remote.canvas.parentElement;
      if (parent) {
        const rect = parent.getBoundingClientRect();
        remote.canvas.width = rect.width;
        remote.canvas.height = rect.height;
      }
      drawRemoteWhiteboard(pid);
    }
  });
}

/**
 * Socket.io Real-Time Synchronization Listeners
 */
function setupSocketEvents() {
  if (!socket) return;

  socket.on("whiteboard-init", ({ whiteboards }) => {
    console.log("[Whiteboard] Synchronizing initial state per presenter...");
    allWhiteboards = whiteboards || {};
    
    const myId = socket.id;
    if (myId && allWhiteboards[myId]) {
      paths = allWhiteboards[myId].paths || [];
    } else {
      paths = [];
    }
    drawAll();

    Object.keys(remoteCanvases).forEach(pid => {
      drawRemoteWhiteboard(pid);
    });
  });

  socket.on("wb-draw", ({ presenterId, path }) => {
    if (presenterId === socket.id) return;
    if (!allWhiteboards[presenterId]) {
      allWhiteboards[presenterId] = { paths: [] };
    }
    allWhiteboards[presenterId].paths.push(path);
    drawRemoteWhiteboard(presenterId);
  });

  socket.on("wb-move", ({ presenterId, elementId, dx, dy }) => {
    if (presenterId === socket.id) return;
    const wb = allWhiteboards[presenterId];
    if (wb) {
      const el = wb.paths.find(p => p.id === elementId);
      if (el) {
        translateElement(el, dx, dy);
        drawRemoteWhiteboard(presenterId);
      }
    }
  });

  socket.on("wb-delete", ({ presenterId, elementId }) => {
    if (presenterId === socket.id) return;
    const wb = allWhiteboards[presenterId];
    if (wb) {
      wb.paths = wb.paths.filter(p => p.id !== elementId);
      drawRemoteWhiteboard(presenterId);
    }
  });

  socket.on("wb-undo", ({ presenterId, elementId }) => {
    if (presenterId === socket.id) return;
    const wb = allWhiteboards[presenterId];
    if (wb) {
      wb.paths = wb.paths.filter(p => p.id !== elementId);
      drawRemoteWhiteboard(presenterId);
    }
  });

  socket.on("wb-redo", ({ presenterId, path }) => {
    if (presenterId === socket.id) return;
    if (!allWhiteboards[presenterId]) {
      allWhiteboards[presenterId] = { paths: [] };
    }
    allWhiteboards[presenterId].paths.push(path);
    drawRemoteWhiteboard(presenterId);
  });

  socket.on("wb-clear", ({ presenterId }) => {
    if (presenterId === socket.id) return;
    if (allWhiteboards[presenterId]) {
      allWhiteboards[presenterId].paths = [];
    }
    drawRemoteWhiteboard(presenterId);
  });
}
