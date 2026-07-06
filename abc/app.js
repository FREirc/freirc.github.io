const DEFAULT_ABC = `X:1
T:Simple Reel
M:4/4
L:1/8
Q:120
K:C
CDEF GABc | cBAG FEDC | E2 G2 c2 B2 | A4 G4 |]`;

const NOTE_BASE = {
  C: 60,
  D: 62,
  E: 64,
  F: 65,
  G: 67,
  A: 69,
  B: 71,
};

const KEY_SIGNATURES = {
  C: {},
  G: { F: 1 },
  D: { F: 1, C: 1 },
  A: { F: 1, C: 1, G: 1 },
  E: { F: 1, C: 1, G: 1, D: 1 },
  B: { F: 1, C: 1, G: 1, D: 1, A: 1 },
  F: { B: -1 },
  Bb: { B: -1, E: -1 },
  Eb: { B: -1, E: -1, A: -1 },
  Am: {},
  Em: { F: 1 },
  Dm: { B: -1 },
};

const abcInput = document.querySelector("#abcInput");
const canvas = document.querySelector("#rollCanvas");
const scroller = document.querySelector("#rollScroller");
const workspace = document.querySelector(".workspace");
const splitter = document.querySelector("#splitter");
const ctx = canvas.getContext("2d");
const tempoInput = document.querySelector("#tempoInput");
const zoomInput = document.querySelector("#zoomInput");
const snapInput = document.querySelector("#snapInput");
const playButton = document.querySelector("#playButton");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const deleteButton = document.querySelector("#deleteButton");
const saveSessionButton = document.querySelector("#saveSessionButton");
const loadSessionButton = document.querySelector("#loadSessionButton");
const deleteSessionButton = document.querySelector("#deleteSessionButton");
const sessionSelect = document.querySelector("#sessionSelect");
const statusEl = document.querySelector("#status");
const summaryEl = document.querySelector("#summary");
const rangeLabel = document.querySelector("#rangeLabel");
const beatCounter = document.querySelector("#beatCounter");

const ROLL = {
  keyWidth: 74,
  rowHeight: 20,
  rulerHeight: 24,
  defaultMinMidi: 36,
  defaultMaxMidi: 84,
};

let parsed = { notes: [], totalBeats: 0, tempo: 120, errors: [] };
let audioCtx = null;
let scheduled = [];
let playing = false;
let playStart = 0;
let playTimer = 0;
let selectedNoteId = null;
let selectedNoteIds = new Set();
let dragDraft = null;
let interaction = null;
let lastRoll = null;
let playheadBeats = 0;
let undoStack = [];
let redoStack = [];
let noteClipboard = [];

const SESSION_COOKIE = "abcEditorSessions";
const SESSION_COOKIE_CHUNK = 3000;

abcInput.value = DEFAULT_ABC;
parseAndRender();

abcInput.addEventListener("input", parseAndRender);
tempoInput.addEventListener("input", () => {
  parsed.tempo = clamp(Number(tempoInput.value) || 120, 30, 240);
  renderRoll();
});
zoomInput.addEventListener("input", renderRoll);
snapInput.addEventListener("change", renderRoll);
playButton.addEventListener("click", startPlayback);
pauseButton.addEventListener("click", pausePlayback);
stopButton.addEventListener("click", stopAndRewind);
deleteButton.addEventListener("click", deleteSelectedNote);
saveSessionButton.addEventListener("click", saveCurrentSession);
loadSessionButton.addEventListener("click", loadSelectedSession);
deleteSessionButton.addEventListener("click", deleteSelectedSession);
canvas.addEventListener("pointerdown", onRollPointerDown);
canvas.addEventListener("pointermove", onRollPointerMove);
canvas.addEventListener("pointerup", onRollPointerUp);
canvas.addEventListener("pointercancel", cancelDraft);
scroller.addEventListener("wheel", onRollWheel, { passive: false });
splitter.addEventListener("pointerdown", onSplitterPointerDown);
splitter.addEventListener("keydown", onSplitterKeyDown);
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
window.addEventListener("pointermove", onWindowPointerMove);
window.addEventListener("pointerup", onWindowPointerUp);
window.addEventListener("resize", renderRoll);
refreshSessionSelect();

function parseAndRender() {
  stopPlayback();
  parsed = parseAbc(abcInput.value);
  selectedNoteId = null;
  selectedNoteIds = new Set();
  playheadBeats = clamp(playheadBeats, 0, parsed.totalBeats);
  tempoInput.value = String(parsed.tempo);
  renderRoll();
}

function parseAbc(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const headers = { unitLength: 0.125, meter: "4/4", tempo: Number(tempoInput.value) || 120, key: "C" };
  const voiceBodies = new Map([["default", []]]);
  let currentVoice = "default";
  const errors = [];

  for (const line of lines) {
    const clean = line.replace(/%.*/, "").trimEnd();
    if (!clean.trim()) continue;
    const header = clean.match(/^([A-Za-z]):\s*(.*)$/);
    if (header) {
      const [, key, value] = header;
      if (key === "L") headers.unitLength = parseFraction(value.trim(), 0.125);
      if (key === "M") headers.meter = value.trim();
      if (key === "Q") headers.tempo = parseTempo(value.trim(), headers.tempo);
      if (key === "K") headers.key = normalizeKey(value.trim());
      if (key === "V") {
        currentVoice = value.trim().split(/\s+/)[0] || "default";
        if (!voiceBodies.has(currentVoice)) voiceBodies.set(currentVoice, []);
      }
      continue;
    }
    const inlineVoice = clean.match(/^\[V:([^\]]+)]\s*(.*)$/);
    if (inlineVoice) {
      currentVoice = inlineVoice[1].trim().split(/\s+/)[0] || "default";
      if (!voiceBodies.has(currentVoice)) voiceBodies.set(currentVoice, []);
      voiceBodies.get(currentVoice).push(inlineVoice[2]);
    } else {
      voiceBodies.get(currentVoice).push(clean);
    }
  }

  const notes = [];
  let totalBeats = 0;
  for (const body of voiceBodies.values()) {
    const parsedVoice = parseMusicText(body.join(" "), headers, errors);
    notes.push(...parsedVoice.notes);
    totalBeats = Math.max(totalBeats, parsedVoice.totalBeats);
  }

  return { notes, totalBeats, tempo: headers.tempo, errors, key: headers.key, meter: headers.meter };
}

function parseMusicText(text, headers, errors) {
  const notes = [];
  const keyAccidentals = KEY_SIGNATURES[headers.key] || {};
  let beat = 0;
  let i = 0;
  let tupletRemaining = 0;
  let tupletScale = 1;
  const localAccidentals = {};

  while (i < text.length) {
    const char = text[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "|") {
      i = skipBar(text, i);
      for (const noteName of Object.keys(localAccidentals)) delete localAccidentals[noteName];
      continue;
    }

    if (char === "(" && /\d/.test(text[i + 1] || "")) {
      const count = Number(text[i + 1]);
      tupletRemaining = count;
      tupletScale = count === 3 ? 2 / 3 : 1;
      i += 2;
      continue;
    }

    if ("[](){}<>".includes(char)) {
      i += 1;
      continue;
    }

    const accidental = readAccidental(text, i);
    i = accidental.next;
    const noteChar = text[i];

    if (!noteChar || !/[A-Ga-gzZ]/.test(noteChar)) {
      if (accidental.value !== null) errors.push(`Ignored accidental at column ${i + 1}`);
      i += 1;
      continue;
    }

    i += 1;
    const octave = readOctave(text, i);
    i = octave.next;
    const length = readLength(text, i);
    i = length.next;

    const duration = length.multiplier * headers.unitLength * 4 * tupletScale;
    if (/[zZ]/.test(noteChar)) {
      beat += duration;
      if (tupletRemaining > 0) {
        tupletRemaining -= 1;
        if (tupletRemaining === 0) tupletScale = 1;
      }
      continue;
    }

    const noteName = noteChar.toUpperCase();
    if (accidental.value !== null) localAccidentals[noteName] = accidental.value;
    const keyOffset = keyAccidentals[noteName] || 0;
    const localOffset = localAccidentals[noteName];
    const accidentalOffset = localOffset === undefined ? keyOffset : localOffset;
    const base = NOTE_BASE[noteName] + (noteChar === noteChar.toLowerCase() ? 12 : 0);
    const midi = base + octave.shift * 12 + accidentalOffset;

    notes.push({
      id: createNoteId(),
      midi,
      start: beat,
      duration,
      name: midiToName(midi),
    });
    beat += duration;
    if (tupletRemaining > 0) {
      tupletRemaining -= 1;
      if (tupletRemaining === 0) tupletScale = 1;
    }
  }

  return { notes, totalBeats: beat };
}

function readAccidental(text, index) {
  const char = text[index];
  if (char === "^") {
    return { value: text[index + 1] === "^" ? 2 : 1, next: index + (text[index + 1] === "^" ? 2 : 1) };
  }
  if (char === "_") {
    return { value: text[index + 1] === "_" ? -2 : -1, next: index + (text[index + 1] === "_" ? 2 : 1) };
  }
  if (char === "=") return { value: 0, next: index + 1 };
  return { value: null, next: index };
}

function readOctave(text, index) {
  let shift = 0;
  while (text[index] === "," || text[index] === "'") {
    shift += text[index] === "'" ? 1 : -1;
    index += 1;
  }
  return { shift, next: index };
}

function readLength(text, index) {
  const match = text.slice(index).match(/^(\d+)?(\/(\d+)?)?/);
  if (!match || match[0] === "") return { multiplier: 1, next: index };
  const number = match[1] ? Number(match[1]) : 1;
  let divider = 1;
  if (match[2]) divider = match[3] ? Number(match[3]) : 2;
  return { multiplier: number / divider, next: index + match[0].length };
}

function skipBar(text, index) {
  while (text[index] === "|" || text[index] === ":" || text[index] === "]" || text[index] === "[") index += 1;
  return index;
}

function renderRoll(progressBeats = null) {
  const notes = dragDraft ? [...parsed.notes, draftToNote(dragDraft)] : parsed.notes;
  const pixelRatio = window.devicePixelRatio || 1;
  const beatWidth = Number(zoomInput.value);
  const minMidi = notes.length ? Math.max(21, Math.min(ROLL.defaultMinMidi, Math.min(...notes.map((note) => note.midi)) - 2)) : ROLL.defaultMinMidi;
  const maxMidi = notes.length ? Math.min(108, Math.max(ROLL.defaultMaxMidi, Math.max(...notes.map((note) => note.midi)) + 2)) : ROLL.defaultMaxMidi;
  const rows = maxMidi - minMidi + 1;
  const totalBeats = Math.max(parsed.totalBeats, playheadBeats, dragDraft ? Math.max(dragDraft.start, dragDraft.end) : 0, 16);
  const width = Math.max(scroller.clientWidth, ROLL.keyWidth + Math.ceil((totalBeats + 1) * beatWidth));
  const height = Math.max(scroller.clientHeight, ROLL.rulerHeight + rows * ROLL.rowHeight + 1);

  lastRoll = { beatWidth, minMidi, maxMidi, width, height };

  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(width * pixelRatio);
  canvas.height = Math.floor(height * pixelRatio);
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const tripletZones = tripletZonesFromNotes(notes);
  drawBackground(width, height, ROLL.keyWidth, ROLL.rowHeight, beatWidth, minMidi, maxMidi);
  drawTripletZones(tripletZones, width, height, beatWidth);
  drawNotes(notes, ROLL.keyWidth, ROLL.rowHeight, beatWidth, minMidi, maxMidi);

  const visiblePlayhead = progressBeats === null ? playheadBeats : progressBeats;
  if (visiblePlayhead !== null) {
    const x = ROLL.keyWidth + visiblePlayhead * beatWidth;
    ctx.fillStyle = "rgba(37, 111, 122, 0.35)";
    ctx.fillRect(x - 1, 0, 2, height);
  }

  summaryEl.textContent = `${parsed.notes.length} 个音符 | ${parsed.totalBeats.toFixed(1)} 拍 | ${parsed.key || "C"}`;
  statusEl.textContent = parsed.errors.length ? `${parsed.errors.length} 个解析提醒` : "就绪";
  rangeLabel.textContent = selectionLabel(minMidi, maxMidi);
  deleteButton.disabled = selectedNoteIds.size === 0;
  beatCounter.value = formatBeatCounter(visiblePlayhead || 0);
  beatCounter.textContent = beatCounter.value;
}

function drawBackground(width, height, keyWidth, rowHeight, beatWidth, minMidi, maxMidi) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e8eeee";
  ctx.fillRect(0, 0, keyWidth, height);
  ctx.fillStyle = "#f4f7f5";
  ctx.fillRect(keyWidth, 0, width - keyWidth, ROLL.rulerHeight);
  ctx.strokeStyle = "#cfd7d3";
  ctx.beginPath();
  ctx.moveTo(0, ROLL.rulerHeight + 0.5);
  ctx.lineTo(width, ROLL.rulerHeight + 0.5);
  ctx.stroke();

  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    const y = ROLL.rulerHeight + (maxMidi - midi) * rowHeight;
    const pitchClass = ((midi % 12) + 12) % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(pitchClass);
    ctx.fillStyle = isBlack ? "rgba(41, 39, 36, 0.07)" : "rgba(255, 255, 255, 0.55)";
    ctx.fillRect(keyWidth, y, width - keyWidth, rowHeight);
    ctx.strokeStyle = "#dde5e1";
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();

    ctx.fillStyle = isBlack ? "#292724" : "#ffffff";
    ctx.fillRect(0, y, keyWidth, rowHeight);
    ctx.strokeStyle = "#cfd7d3";
    ctx.strokeRect(0, y, keyWidth, rowHeight);
    if (pitchClass === 0) {
      ctx.fillStyle = isBlack ? "#fff" : "#4f4942";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(midiToName(midi), 10, y + 14);
    }
  }

  const beats = Math.ceil((width - keyWidth) / beatWidth);
  for (let beat = 0; beat <= beats; beat += 1) {
    const x = keyWidth + beat * beatWidth;
    ctx.strokeStyle = beat % 4 === 0 ? "#aab8b4" : "#dde5e1";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
    if (beat % 4 === 0) {
      ctx.fillStyle = "#756e64";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(String(beat + 1), x + 4, 15);
    }
  }
}

function drawNotes(notes, keyWidth, rowHeight, beatWidth, minMidi, maxMidi) {
  for (const note of notes) {
    const x = keyWidth + note.start * beatWidth;
    const y = ROLL.rulerHeight + (maxMidi - note.midi) * rowHeight + 2;
    const w = Math.max(8, note.duration * beatWidth - 3);
    const h = rowHeight - 4;
    const selected = selectedNoteIds.has(note.id);
    const draft = note.id === "draft";
    ctx.fillStyle = draft ? "rgba(37, 111, 122, 0.45)" : selected ? "#256f7a" : "#db5a42";
    ctx.strokeStyle = selected || draft ? "#174e57" : "#9e382b";
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();
    if (w > 34) {
      ctx.fillStyle = "#fff8ef";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(note.name, x + 7, y + 13);
    }
  }

  if (interaction && interaction.type === "select") drawSelectionBox(interaction.startPoint, interaction.currentPoint);
}

function drawTripletZones(zones, width, height, beatWidth) {
  for (const zone of zones) {
    const x = ROLL.keyWidth + zone.start * beatWidth;
    const w = zone.length * beatWidth;
    ctx.fillStyle = "rgba(37, 111, 122, 0.09)";
    ctx.fillRect(x, ROLL.rulerHeight, w, height - ROLL.rulerHeight);
    ctx.strokeStyle = "rgba(37, 111, 122, 0.55)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x + 0.5, ROLL.rulerHeight + 0.5, w, height - ROLL.rulerHeight - 1);
    ctx.setLineDash([]);

    for (let slot = 1; slot < 3; slot += 1) {
      const slotX = x + slot * zone.unit * beatWidth;
      ctx.strokeStyle = "rgba(37, 111, 122, 0.35)";
      ctx.beginPath();
      ctx.moveTo(slotX + 0.5, ROLL.rulerHeight);
      ctx.lineTo(slotX + 0.5, height);
      ctx.stroke();
    }

    if (w > 44) {
      ctx.fillStyle = "#256f7a";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(`3:${tripletZoneLabel(zone.unit)}`, x + 5, ROLL.rulerHeight + 13);
    }
  }
}

function onRollPointerDown(event) {
  if (!lastRoll) return;
  const point = eventToRollPoint(event);

  if (point.y <= ROLL.rulerHeight && point.x >= ROLL.keyWidth) {
    interaction = { type: "seek", pointerId: event.pointerId };
    seekToPoint(point);
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  if (playing) return;

  if (event.ctrlKey && point.x >= ROLL.keyWidth) {
    interaction = { type: "select", pointerId: event.pointerId, startPoint: point, currentPoint: point };
    selectedNoteId = null;
    selectedNoteIds = new Set();
    canvas.setPointerCapture(event.pointerId);
    renderRoll();
    return;
  }

  const hit = findNoteAt(point.x, point.y);
  if (hit) {
    if (!selectedNoteIds.has(hit.id)) selectedNoteIds = new Set([hit.id]);
    selectedNoteId = hit.id;
    dragDraft = null;
    if (isNoteTailHit(hit, point.x, point.y)) {
      interaction = { type: "resize", pointerId: event.pointerId, note: { ...hit }, resized: false, beforeNotes: cloneNotes(parsed.notes) };
      canvas.setPointerCapture(event.pointerId);
      renderRoll();
      return;
    }
    interaction = {
      type: "move",
      pointerId: event.pointerId,
      originX: point.x,
      originMidi: yToMidi(point.y),
      moved: false,
      valid: true,
      beforeNotes: cloneNotes(parsed.notes),
      originals: parsed.notes.filter((note) => selectedNoteIds.has(note.id)).map((note) => ({ ...note })),
    };
    canvas.setPointerCapture(event.pointerId);
    renderRoll();
    return;
  }

  if (point.x < ROLL.keyWidth) return;
  const start = quantizeBeat((point.x - ROLL.keyWidth) / lastRoll.beatWidth);
  const midi = yToMidi(point.y);
  interaction = { type: "create", pointerId: event.pointerId };
  dragDraft = { start, end: start + snapValue(), midi };
  selectedNoteId = null;
  selectedNoteIds = new Set();
  canvas.setPointerCapture(event.pointerId);
  renderRoll();
}

function onRollPointerMove(event) {
  if (!interaction || interaction.pointerId !== event.pointerId || !lastRoll) return;
  const point = eventToRollPoint(event);

  if (interaction.type === "seek") {
    seekToPoint(point);
    return;
  }

  if (interaction.type === "select") {
    interaction.currentPoint = point;
    renderRoll();
    return;
  }

  if (interaction.type === "move") {
    const beatDelta = quantizeBeatDelta((point.x - interaction.originX) / lastRoll.beatWidth);
    const midiDelta = yToMidi(point.y) - interaction.originMidi;
    const minStart = Math.min(...interaction.originals.map((note) => note.start));
    const clampedBeatDelta = Math.max(beatDelta, -minStart);
    interaction.moved = interaction.moved || clampedBeatDelta !== 0 || midiDelta !== 0;
    const moved = new Map(
      interaction.originals.map((note) => [
        note.id,
        normalizeNote({ ...note, start: note.start + clampedBeatDelta, midi: note.midi + midiDelta }),
      ]),
    );
    const candidate = interaction.beforeNotes.map((note) => moved.get(note.id) || note);
    interaction.valid = validateTripletIsolation(candidate);
    parsed.notes = interaction.valid ? candidate : cloneNotes(interaction.beforeNotes);
    parsed.totalBeats = totalNoteBeats(parsed.notes);
    renderRoll();
    return;
  }

  if (interaction.type === "resize") {
    if (tripletUnit(interaction.note.duration)) return;
    const duration = Math.max(snapValue(), quantizeBeat(pointToBeat(point.x) - interaction.note.start));
    if (duration === interaction.note.duration) return;
    interaction.resized = true;
    const candidate = parsed.notes.map((note) => (note.id === interaction.note.id ? normalizeNote({ ...note, duration }) : note));
    interaction.valid = validateTripletIsolation(candidate);
    parsed.notes = interaction.valid ? candidate : cloneNotes(interaction.beforeNotes);
    parsed.totalBeats = totalNoteBeats(parsed.notes);
    renderRoll();
    return;
  }

  if (!dragDraft) return;
  const end = quantizeBeat((point.x - ROLL.keyWidth) / lastRoll.beatWidth);
  dragDraft.end = isTripletSnap() ? dragDraft.start + snapValue() : Math.max(dragDraft.start + snapValue(), end);
  dragDraft.midi = yToMidi(point.y);
  renderRoll();
}

function onRollPointerUp(event) {
  if (!interaction || interaction.pointerId !== event.pointerId) return;

  if (interaction.type === "create" && dragDraft) {
    const note = normalizeNote(draftToNote(dragDraft));
    dragDraft = null;
    selectedNoteId = note.id;
    selectedNoteIds = new Set([note.id]);
    const nextNotes = [...parsed.notes, note];
    if (validateTripletIsolation(nextNotes)) applyGeneratedNotes(nextNotes);
    else {
      selectedNoteId = null;
      selectedNoteIds = new Set();
      renderRoll();
    }
  } else if (interaction.type === "move" && interaction.moved && interaction.valid !== false) {
    applyGeneratedNotes(parsed.notes, { beforeNotes: interaction.beforeNotes });
  } else if (interaction.type === "move") {
    parsed.notes = cloneNotes(interaction.beforeNotes);
    parsed.totalBeats = totalNoteBeats(parsed.notes);
    renderRoll();
  } else if (interaction.type === "resize" && interaction.resized && interaction.valid !== false) {
    applyGeneratedNotes(parsed.notes, { beforeNotes: interaction.beforeNotes });
  } else if (interaction.type === "resize") {
    parsed.notes = cloneNotes(interaction.beforeNotes);
    parsed.totalBeats = totalNoteBeats(parsed.notes);
    renderRoll();
  } else if (interaction.type === "select") {
    selectedNoteIds = notesInSelection(interaction.startPoint, interaction.currentPoint);
    selectedNoteId = selectedNoteIds.values().next().value || null;
    renderRoll();
  }

  interaction = null;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch (_) {}
}

function cancelDraft() {
  if (!dragDraft && !interaction) return;
  dragDraft = null;
  interaction = null;
  renderRoll();
}

function deleteSelectedNote() {
  if (selectedNoteIds.size === 0) return;
  const nextNotes = parsed.notes.filter((note) => !selectedNoteIds.has(note.id));
  selectedNoteId = null;
  selectedNoteIds = new Set();
  applyGeneratedNotes(nextNotes);
}

function onKeyDown(event) {
  if (event.key === "Alt") {
    event.preventDefault();
    return;
  }
  if (event.target === abcInput) return;
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === "z" && event.shiftKey) {
      event.preventDefault();
      redoNotes();
      return;
    }
    if (key === "z") {
      event.preventDefault();
      undoNotes();
      return;
    }
    if (key === "y") {
      event.preventDefault();
      redoNotes();
      return;
    }
    if (key === "c") {
      event.preventDefault();
      copySelectedNotes();
      return;
    }
    if (key === "a") {
      event.preventDefault();
      selectAllNotes();
      return;
    }
    if (key === "x") {
      event.preventDefault();
      cutSelectedNotes();
      return;
    }
    if (key === "v") {
      event.preventDefault();
      pasteNotes();
      return;
    }
  }
  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    deleteSelectedNote();
  }
}

function onKeyUp(event) {
  if (event.key === "Alt") event.preventDefault();
}

function applyGeneratedNotes(notes, options = {}) {
  stopPlayback();
  if (options.recordHistory !== false) {
    undoStack.push(cloneNotes(options.beforeNotes || parsed.notes));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }
  const normalized = notes.map(normalizeNote).sort((a, b) => a.start - b.start || a.midi - b.midi);
  parsed = {
    ...parsed,
    notes: normalized,
    totalBeats: totalNoteBeats(normalized),
    errors: [],
    key: "C",
    meter: "4/4",
  };
  abcInput.value = serializeNotesToAbc(parsed.notes, parsed.tempo);
  renderRoll();
}

function restoreNotes(notes) {
  stopPlayback();
  const normalized = cloneNotes(notes).map(normalizeNote).sort((a, b) => a.start - b.start || a.midi - b.midi);
  parsed = {
    ...parsed,
    notes: normalized,
    totalBeats: totalNoteBeats(normalized),
    errors: [],
    key: "C",
    meter: "4/4",
  };
  selectedNoteId = null;
  selectedNoteIds = new Set();
  abcInput.value = serializeNotesToAbc(parsed.notes, parsed.tempo);
  renderRoll();
}

function undoNotes() {
  if (!undoStack.length) return;
  redoStack.push(cloneNotes(parsed.notes));
  restoreNotes(undoStack.pop());
}

function redoNotes() {
  if (!redoStack.length) return;
  undoStack.push(cloneNotes(parsed.notes));
  restoreNotes(redoStack.pop());
}

function copySelectedNotes() {
  const selected = parsed.notes.filter((note) => selectedNoteIds.has(note.id));
  if (!selected.length) return;
  const start = Math.min(...selected.map((note) => note.start));
  noteClipboard = selected.map((note) => ({
    midi: note.midi,
    start: note.start - start,
    duration: note.duration,
    name: note.name,
  }));
}

function selectAllNotes() {
  selectedNoteIds = new Set(parsed.notes.map((note) => note.id));
  selectedNoteId = parsed.notes[0]?.id || null;
  renderRoll();
}

function cutSelectedNotes() {
  if (!selectedNoteIds.size) return;
  copySelectedNotes();
  deleteSelectedNote();
}

function pasteNotes() {
  if (!noteClipboard.length) return;
  const pasteStart = quantizeBeat(playheadBeats);
  const pasted = noteClipboard.map((note) => normalizeNote({
    ...note,
    id: createNoteId(),
    start: pasteStart + note.start,
  }));
  const pastedIds = new Set(pasted.map((note) => note.id));
  const nextNotes = [...parsed.notes, ...pasted];
  if (!validateTripletIsolation(nextNotes)) return;
  applyGeneratedNotes(nextNotes);
  selectedNoteIds = pastedIds;
  selectedNoteId = pasted[0]?.id || null;
  renderRoll();
}

function saveCurrentSession() {
  const sessions = readSessions();
  const now = new Date();
  const session = {
    id: `s${now.getTime().toString(36)}`,
    updatedAt: now.toISOString(),
    abc: abcInput.value,
    tempo: parsed.tempo,
    snap: snapInput.value,
    zoom: zoomInput.value,
    playhead: playheadBeats,
  };
  sessions.unshift(session);
  const trimmed = sessions.slice(0, 12);

  if (!writeSessions(trimmed)) {
    statusEl.textContent = "保存失败：cookie 容量不足";
    return;
  }

  refreshSessionSelect(session.id);
  statusEl.textContent = "会话已保存";
}

function loadSelectedSession() {
  const session = readSessions().find((item) => item.id === sessionSelect.value);
  if (!session) return;
  stopPlayback(true);
  abcInput.value = session.abc || DEFAULT_ABC;
  tempoInput.value = String(session.tempo || 120);
  snapInput.value = session.snap || "0.5";
  zoomInput.value = session.zoom || "88";
  playheadBeats = Number(session.playhead) || 0;
  parsed = parseAbc(abcInput.value);
  tempoInput.value = String(parsed.tempo);
  selectedNoteId = null;
  selectedNoteIds = new Set();
  undoStack = [];
  redoStack = [];
  renderRoll();
  statusEl.textContent = "会话已加载";
}

function deleteSelectedSession() {
  if (!sessionSelect.value) return;
  const sessions = readSessions().filter((item) => item.id !== sessionSelect.value);
  writeSessions(sessions);
  refreshSessionSelect();
  statusEl.textContent = "会话已删除";
}

function refreshSessionSelect(selectedId = "") {
  const sessions = readSessions();
  sessionSelect.innerHTML = "";
  if (!sessions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "无已保存会话";
    sessionSelect.append(option);
  } else {
    for (const session of sessions) {
      const option = document.createElement("option");
      option.value = session.id;
      option.textContent = formatSessionLabel(session);
      sessionSelect.append(option);
    }
  }
  sessionSelect.value = selectedId || sessions[0]?.id || "";
  loadSessionButton.disabled = !sessionSelect.value;
  deleteSessionButton.disabled = !sessionSelect.value;
}

function readSessions() {
  const value = readChunkedCookie(SESSION_COOKIE);
  if (!value) return [];
  try {
    const parsedSessions = JSON.parse(value);
    return Array.isArray(parsedSessions) ? parsedSessions : [];
  } catch (_) {
    return [];
  }
}

function writeSessions(sessions) {
  const value = JSON.stringify(sessions);
  writeChunkedCookie(SESSION_COOKIE, value);
  return readChunkedCookie(SESSION_COOKIE) === value;
}

function readCookie(name) {
  const prefix = `${name}=`;
  const cookie = document.cookie.split("; ").find((item) => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

function readChunkedCookie(name) {
  const chunkCount = Number(readCookie(`${name}Count`));
  if (!chunkCount) return readCookie(name);

  let value = "";
  for (let i = 0; i < chunkCount; i += 1) value += readCookie(`${name}${i}`);
  return value;
}

function writeChunkedCookie(name, value) {
  clearChunkedCookie(name);
  const encoded = encodeURIComponent(value);
  const chunks = [];
  for (let i = 0; i < encoded.length; i += SESSION_COOKIE_CHUNK) chunks.push(encoded.slice(i, i + SESSION_COOKIE_CHUNK));

  document.cookie = `${name}Count=${chunks.length}; max-age=31536000; path=/; samesite=lax`;
  chunks.forEach((chunk, index) => {
    document.cookie = `${name}${index}=${chunk}; max-age=31536000; path=/; samesite=lax`;
  });
}

function clearChunkedCookie(name) {
  const oldCount = Number(readCookie(`${name}Count`)) || 0;
  document.cookie = `${name}=; max-age=0; path=/; samesite=lax`;
  document.cookie = `${name}Count=; max-age=0; path=/; samesite=lax`;
  for (let i = 0; i < Math.max(oldCount, 30); i += 1) {
    document.cookie = `${name}${i}=; max-age=0; path=/; samesite=lax`;
  }
}

function formatSessionLabel(session) {
  const date = new Date(session.updatedAt);
  const stamp = Number.isNaN(date.getTime()) ? "未知时间" : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const title = (session.abc || "").match(/^T:\s*(.+)$/m)?.[1]?.trim() || "未命名";
  return `${stamp} ${title}`;
}

function serializeNotesToAbc(notes, tempo) {
  const voices = assignVoices(notes);
  const zones = tripletZonesFromNotes(notes);
  const header = [`X:1`, `T:Generated Piano Roll`, `M:4/4`, `L:1/8`, `Q:1/4=${tempo}`, `K:C`];

  if (voices.length <= 1) return [...header, serializeVoice(voices[0] || [], zones) || "z8"].join("\n");

  const voiceLines = voices.flatMap((voice, index) => [`V:${index + 1}`, serializeVoice(voice, zones) || "z8"]);
  return [...header, ...voiceLines].join("\n");
}

function assignVoices(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || b.duration - a.duration || a.midi - b.midi);
  const voices = [];

  for (const note of sorted) {
    const voice = voices.find((items) => !items.length || items[items.length - 1].start + items[items.length - 1].duration <= note.start + 0.0001);
    if (voice) voice.push(note);
    else voices.push([note]);
  }

  return voices;
}

function serializeVoice(notes, zones = []) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  const tokens = [];
  const accidentalState = {};
  let cursor = 0;
  let i = 0;

  while (i < sorted.length) {
    const note = sorted[i];
    const zone = tripletZoneForNote(note, zones);

    if (zone) {
      if (zone.start > cursor) appendTimedTokens(tokens, cursor, zone.start - cursor, (duration) => abcText("z", duration));
      renderTripletZone(tokens, zone, sorted, accidentalState);
      cursor = zone.end;
      while (i < sorted.length && sorted[i].start < zone.end - 0.0001) i += 1;
      continue;
    }

    if (note.start < cursor - 0.0001) {
      i += 1;
      continue;
    }

    if (note.start > cursor) appendTimedTokens(tokens, cursor, note.start - cursor, (duration) => abcText("z", duration));
    const pitch = abcPitch(note.midi, accidentalState);
    appendTimedTokens(tokens, note.start, note.duration, (duration) => abcText(pitch, duration));
    cursor = Math.max(cursor, note.start + note.duration);
    i += 1;
  }

  while (tokens[tokens.length - 1] === "|") tokens.pop();
  return tokens.join(" ");
}

function appendTimedTokens(tokens, start, duration, formatToken) {
  let remaining = duration;
  let position = start;

  while (remaining > 0) {
    const nextBar = Math.floor(position / 4) * 4 + 4;
    const chunk = cleanBeat(Math.min(remaining, nextBar - position || 4));
    if (chunk <= 0) break;
    tokens.push(formatToken(chunk));
    position += chunk;
    remaining = Math.max(0, cleanBeat(remaining - chunk));
    if (remaining > 0 || isBarBoundary(position)) tokens.push("|");
  }
}

function renderTripletZone(tokens, zone, notes, accidentalState) {
  const parts = [];

  for (let slot = 0; slot < 3; slot += 1) {
    const slotStart = zone.start + slot * zone.unit;
    const note = notes.find((item) => {
      return nearlyEqual(item.start, slotStart) && nearlyEqual(item.duration, zone.unit) && sameTripletZone(tripletZoneFor(item.start, zone.unit), zone);
    });

    const base = note ? abcPitch(note.midi, accidentalState) : "z";
    parts.push(`${base}${abcTripletLength(zone.unit)}`);
  }

  tokens.push(`(3${parts.join("")}`);
  if (isBarBoundary(zone.end)) tokens.push("|");
}

function tripletZoneForNote(note, zones) {
  const unit = tripletUnit(note.duration);
  if (!unit) return null;
  return zones.find((zone) => sameTripletZone(zone, tripletZoneFor(note.start, unit))) || null;
}

function tripletUnit(duration) {
  if (nearlyEqual(duration, 1 / 3)) return 1 / 3;
  if (nearlyEqual(duration, 2 / 3)) return 2 / 3;
  if (nearlyEqual(duration, 4 / 3)) return 4 / 3;
  return 0;
}

function tripletZonesFromNotes(notes) {
  const zones = new Map();

  for (const note of notes) {
    const unit = tripletUnit(note.duration);
    if (!unit) continue;
    const zone = tripletZoneFor(note.start, unit);
    zones.set(`${unit}:${zone.start}`, zone);
  }

  return [...zones.values()].sort((a, b) => a.start - b.start || a.unit - b.unit);
}

function tripletZoneFor(start, unit) {
  const length = unit * 3;
  const zoneStart = cleanBeat(Math.floor((start + 0.0001) / length) * length);
  return { start: zoneStart, end: cleanBeat(zoneStart + length), length, unit };
}

function tripletZoneAt(position, zones) {
  return zones.find((zone) => position >= zone.start - 0.0001 && position < zone.end - 0.0001) || null;
}

function validateTripletIsolation(notes) {
  const zones = tripletZonesFromNotes(notes);

  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      if (rangesOverlap(zones[i].start, zones[i].end, zones[j].start, zones[j].end) && !nearlyEqual(zones[i].unit, zones[j].unit)) {
        return false;
      }
    }
  }

  for (const note of notes) {
    const unit = tripletUnit(note.duration);
    const overlappingZones = zones.filter((zone) => rangesOverlap(note.start, note.start + note.duration, zone.start, zone.end));

    if (!unit) {
      if (overlappingZones.length) return false;
      continue;
    }

    const ownZone = tripletZoneFor(note.start, unit);
    if (!nearlyEqual(note.duration, unit) || !isTripletSlotStart(note.start, ownZone)) return false;
    if (overlappingZones.some((zone) => !sameTripletZone(zone, ownZone))) return false;
  }

  return true;
}

function isTripletSlotStart(start, zone) {
  for (let slot = 0; slot < 3; slot += 1) {
    if (nearlyEqual(start, zone.start + slot * zone.unit)) return true;
  }
  return false;
}

function sameTripletZone(a, b) {
  return nearlyEqual(a.start, b.start) && nearlyEqual(a.unit, b.unit);
}

function isTripletSnap() {
  return Boolean(tripletUnit(snapValue()));
}

function tripletZoneLabel(unit) {
  if (nearlyEqual(unit, 1 / 3)) return "1/12";
  if (nearlyEqual(unit, 2 / 3)) return "1/6";
  if (nearlyEqual(unit, 4 / 3)) return "1/3";
  return "triplet";
}

function isBarBoundary(beat) {
  return beat > 0 && Math.abs(beat / 4 - Math.round(beat / 4)) < 0.0001;
}

function abcPitch(midi, accidentalState = null) {
  const naturalMidi = [60, 62, 64, 65, 67, 69, 71];
  const naturalName = ["C", "D", "E", "F", "G", "A", "B"];
  let bestIndex = 0;
  let bestDiff = Infinity;

  for (let octave = -3; octave <= 5; octave += 1) {
    for (let i = 0; i < naturalMidi.length; i += 1) {
      const candidate = naturalMidi[i] + octave * 12;
      const diff = Math.abs(candidate - midi);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = i;
      }
    }
  }

  const baseMidi = naturalMidi[bestIndex] + Math.round((midi - naturalMidi[bestIndex]) / 12) * 12;
  const accidental = midi - baseMidi;
  const octaveShift = Math.round((baseMidi - naturalMidi[bestIndex]) / 12);
  const baseName = naturalName[bestIndex];
  let letter = baseName;
  if (octaveShift >= 1) letter = letter.toLowerCase() + "'".repeat(octaveShift - 1);
  if (octaveShift < 0) letter += ",".repeat(Math.abs(octaveShift));
  let prefix = accidental === 1 ? "^" : accidental === -1 ? "_" : accidental === 2 ? "^^" : accidental === -2 ? "__" : "";
  if (accidentalState && accidental === 0 && accidentalState[baseName]) prefix = "=";
  if (accidentalState) accidentalState[baseName] = accidental;
  return `${prefix}${letter}`;
}

function abcText(base, duration) {
  return `${base}${abcLength(duration)}`;
}

function abcLength(duration) {
  const units = Math.max(1, Math.round(duration / 0.5));
  if (units === 1) return "";
  return String(units);
}

function abcTripletLength(duration) {
  const units = Math.max(1, Math.round(duration / (1 / 3)));
  return units === 1 ? "" : String(units);
}

function eventToRollPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function findNoteAt(x, y) {
  if (!lastRoll) return null;
  for (let i = parsed.notes.length - 1; i >= 0; i -= 1) {
    const note = parsed.notes[i];
    const rect = noteRect(note);
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return note;
  }
  return null;
}

function isNoteTailHit(note, x, y) {
  const rect = noteRect(note);
  const tailWidth = Math.min(10, Math.max(5, rect.w / 2));
  return x >= rect.x + rect.w - tailWidth && x <= rect.x + rect.w + 3 && y >= rect.y && y <= rect.y + rect.h;
}

function noteRect(note) {
  return {
    x: ROLL.keyWidth + note.start * lastRoll.beatWidth,
    y: ROLL.rulerHeight + (lastRoll.maxMidi - note.midi) * ROLL.rowHeight + 2,
    w: Math.max(8, note.duration * lastRoll.beatWidth - 3),
    h: ROLL.rowHeight - 4,
  };
}

function yToMidi(y) {
  if (!lastRoll) return 60;
  const row = clamp(Math.floor((y - ROLL.rulerHeight) / ROLL.rowHeight), 0, lastRoll.maxMidi - lastRoll.minMidi);
  return lastRoll.maxMidi - row;
}

function pointToBeat(x) {
  if (!lastRoll) return 0;
  return Math.max(0, (x - ROLL.keyWidth) / lastRoll.beatWidth);
}

function seekToPoint(point) {
  playheadBeats = clamp(quantizeBeat(pointToBeat(point.x)), 0, Math.max(parsed.totalBeats, 16));
  if (playing) stopPlayback();
  renderRoll();
}

function notesInSelection(startPoint, endPoint) {
  const left = Math.min(startPoint.x, endPoint.x);
  const right = Math.max(startPoint.x, endPoint.x);
  const top = Math.min(startPoint.y, endPoint.y);
  const bottom = Math.max(startPoint.y, endPoint.y);
  const ids = new Set();

  for (const note of parsed.notes) {
    const x = ROLL.keyWidth + note.start * lastRoll.beatWidth;
    const y = ROLL.rulerHeight + (lastRoll.maxMidi - note.midi) * ROLL.rowHeight + 2;
    const w = Math.max(8, note.duration * lastRoll.beatWidth - 3);
    const h = ROLL.rowHeight - 4;
    if (x < right && left < x + w && y < bottom && top < y + h) ids.add(note.id);
  }

  return ids;
}

function drawSelectionBox(startPoint, endPoint) {
  const x = Math.min(startPoint.x, endPoint.x);
  const y = Math.min(startPoint.y, endPoint.y);
  const w = Math.abs(endPoint.x - startPoint.x);
  const h = Math.abs(endPoint.y - startPoint.y);
  ctx.fillStyle = "rgba(37, 111, 122, 0.12)";
  ctx.strokeStyle = "rgba(37, 111, 122, 0.8)";
  ctx.setLineDash([5, 4]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.setLineDash([]);
}

function draftToNote(draft) {
  return {
    id: "draft",
    midi: draft.midi,
    start: Math.min(draft.start, draft.end),
    duration: Math.abs(draft.end - draft.start),
    name: midiToName(draft.midi),
  };
}

function normalizeNote(note) {
  const midi = clamp(Math.round(note.midi), 21, 108);
  const start = cleanBeat(Math.max(0, note.start));
  const duration = cleanBeat(Math.max(1 / 12, note.duration || snapValue()));
  return {
    id: note.id && note.id !== "draft" ? note.id : createNoteId(),
    midi,
    start,
    duration,
    name: midiToName(midi),
  };
}

function cleanBeat(value) {
  return Math.round(value * 1000000) / 1000000;
}

function selectionLabel(minMidi, maxMidi) {
  if (selectedNoteIds.size === 1) {
    const note = parsed.notes.find((item) => selectedNoteIds.has(item.id));
    return note ? `已选择 ${note.name} @ ${note.start.toFixed(1)}` : `${midiToName(minMidi)}-${midiToName(maxMidi)}`;
  }
  if (selectedNoteIds.size > 1) return `已选择 ${selectedNoteIds.size} 个音符`;
  return `${midiToName(minMidi)}-${midiToName(maxMidi)} | 空格播放 | Ctrl 框选`;
}

function totalNoteBeats(notes) {
  return notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0);
}

function cloneNotes(notes) {
  return notes.map((note) => ({ ...note }));
}

function onRollWheel(event) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const current = Number(zoomInput.value);
    const next = clamp(current + (event.deltaY < 0 ? 8 : -8), Number(zoomInput.min), Number(zoomInput.max));
    const beforeBeat = pointToBeat(eventToRollPoint(event).x);
    zoomInput.value = String(next);
    renderRoll();
    scroller.scrollLeft = Math.max(0, ROLL.keyWidth + beforeBeat * next - (event.clientX - scroller.getBoundingClientRect().left));
    return;
  }
  if (event.altKey) {
    scroller.scrollLeft += event.deltaY || event.deltaX;
    return;
  }
  scroller.scrollTop += event.deltaY;
  if (event.deltaX) scroller.scrollLeft += event.deltaX;
}

function onSplitterPointerDown(event) {
  interaction = {
    type: "splitter",
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: document.querySelector(".rollPane").getBoundingClientRect().width,
  };
  splitter.setPointerCapture(event.pointerId);
}

function onWindowPointerMove(event) {
  if (!interaction || interaction.type !== "splitter") return;
  const rect = workspace.getBoundingClientRect();
  const nextWidth = interaction.startWidth + event.clientX - interaction.startX;
  const percent = clamp((nextWidth / rect.width) * 100, 32, 76);
  workspace.style.setProperty("--roll-width", `${percent}%`);
  renderRoll();
}

function onWindowPointerUp(event) {
  if (!interaction || interaction.type !== "splitter") return;
  try {
    splitter.releasePointerCapture(event.pointerId);
  } catch (_) {}
  interaction = null;
}

function onSplitterKeyDown(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const rect = workspace.getBoundingClientRect();
  const rollWidth = document.querySelector(".rollPane").getBoundingClientRect().width;
  const delta = event.key === "ArrowLeft" ? -32 : 32;
  const percent = clamp(((rollWidth + delta) / rect.width) * 100, 32, 76);
  workspace.style.setProperty("--roll-width", `${percent}%`);
  renderRoll();
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function quantizeBeat(value) {
  return Math.max(0, Math.round(value / snapValue()) * snapValue());
}

function quantizeBeatDelta(value) {
  return Math.round(value / snapValue()) * snapValue();
}

function snapValue() {
  const raw = snapInput.value;
  if (raw.includes("/")) {
    const [numerator, denominator] = raw.split("/").map(Number);
    return denominator ? numerator / denominator : 0.5;
  }
  return Number(raw) || 0.5;
}

function nearlyEqual(a, b, epsilon = 0.0001) {
  return Math.abs(a - b) < epsilon;
}

function formatBeatCounter(beat) {
  const measureLength = meterMeasureLength(parsed.meter || "4/4");
  const safeBeat = Math.max(0, beat);
  const measure = Math.floor(safeBeat / measureLength) + 1;
  const beatInMeasure = safeBeat - Math.floor(safeBeat / measureLength) * measureLength;
  const beatNumber = Math.floor(beatInMeasure) + 1;
  const tick = clamp(Math.floor((beatInMeasure - Math.floor(beatInMeasure) + 0.0001) * 10), 0, 9);
  return `${pad2(measure)}:${pad2(beatNumber)}:${tick}`;
}

function meterMeasureLength(meter) {
  const match = meter.match(/^(\d+)\/(\d+)$/);
  if (!match) return 4;
  return Number(match[1]) * (4 / Number(match[2]));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function createNoteId() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function togglePlayback() {
  if (playing) {
    pausePlayback();
    return;
  }
  startPlayback();
}

function startPlayback() {
  if (playing) return;
  if (!parsed.notes.length) return;
  audioCtx = audioCtx || new AudioContext();
  const now = audioCtx.currentTime + 0.04;
  const secondsPerBeat = 60 / parsed.tempo;
  const startBeat = playheadBeats >= parsed.totalBeats ? 0 : clamp(playheadBeats, 0, parsed.totalBeats);
  playheadBeats = startBeat;
  playStart = now - startBeat * secondsPerBeat;
  playing = true;
  playButton.textContent = "开始";
  scheduled = parsed.notes
    .filter((note) => note.start + note.duration > startBeat)
    .map((note) => {
      const noteStart = Math.max(note.start, startBeat);
      const remaining = note.start + note.duration - noteStart;
      return scheduleNote(note, now + (noteStart - startBeat) * secondsPerBeat, remaining * secondsPerBeat);
    });
  tickPlayback(secondsPerBeat);
}

function pausePlayback() {
  stopPlayback(false);
}

function stopAndRewind() {
  stopPlayback(true);
}

function stopPlayback(rewind = false) {
  scheduled.forEach((node) => {
    try {
      node.stop();
    } catch (_) {}
  });
  scheduled = [];
  playing = false;
  cancelAnimationFrame(playTimer);
  if (rewind) playheadBeats = 0;
  renderRoll();
}

function scheduleNote(note, startTime, duration) {
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(0.16, startTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.max(0.03, duration - 0.025));
  oscillator.connect(gain).connect(audioCtx.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration + 0.03);
  return oscillator;
}

function tickPlayback(secondsPerBeat) {
  if (!playing || !audioCtx) return;
  const elapsed = Math.max(0, audioCtx.currentTime - playStart);
  const progress = elapsed / secondsPerBeat;
  playheadBeats = clamp(progress, 0, parsed.totalBeats);
  renderRoll(progress);
  if (progress <= parsed.totalBeats + 0.15) {
    playTimer = requestAnimationFrame(() => tickPlayback(secondsPerBeat));
  } else {
    playheadBeats = parsed.totalBeats;
    stopPlayback(false);
  }
}

function parseFraction(value, fallback) {
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match) return fallback;
  return Number(match[1]) / Number(match[2]);
}

function parseTempo(value, fallback) {
  const numbers = value.match(/\d+/g);
  return numbers ? clamp(Number(numbers[numbers.length - 1]), 30, 240) : fallback;
}

function normalizeKey(value) {
  const match = value.match(/^([A-Ga-g])([#b]?)(m?)/);
  if (!match) return "C";
  return `${match[1].toUpperCase()}${match[2]}${match[3]}`;
}

function midiToName(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
