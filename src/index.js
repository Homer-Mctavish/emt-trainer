import Moonshine from "./moonshine.js";

/* ---------- Config ---------- */
const MAX_RECORD_SEC = 30;
const DECODE_INTERVAL_MS = 400;
const SILENCE_RMS = 0.012;
const SILENCE_FINALIZE_MS = 750;
const SCENARIO_INDEX_URL = "/scenarios/index.json";
const DEFAULT_RETRY1_AUDIO = "/audio/try_again_1.mp3";
const DEFAULT_RETRY2_AUDIO = "/audio/try_again_2.mp3";
const DEFAULT_THIRD_FAIL_AUDIO = "/audio/move_on.mp3";
const DEFAULT_SUCCESS_AUDIO = "/audio/success.mp3";
const KEYWORD_MIN_MATCH = 3;

/* ---------- State ---------- */
let moonshine;
let currentScenario = null, turns = [];
let turnIdx = 0, attemptsThisTurn = 0, correctCount = 0;
let playingAudio = null;

let streaming = false, decodeTimer = null, lastSpeechTs = 0, recordStart = 0;
let ctx, source, workletNode;

const WINDOW_SEC = 6;
const ring = new Float32Array(16000 * WINDOW_SEC);
let ringWrite = 0, ringFilled = 0;

let modelName;

/* ---------- DOM ---------- */
const elQ = () => document.getElementById("questionBox");
const elLive = () => document.getElementById("liveTranscript");
const elType = () => document.getElementById("typedResponse");
const elSubmit = () => document.getElementById("submitResponse");
const elChecklist = () => document.getElementById("checklist");
const elProgress = () => document.getElementById("progressLabel");
const elRec = () => document.getElementById("btnRecord");
const elStop = () => document.getElementById("btnStop");
const elScenario = () => document.getElementById("scenarioSelect");

document.getElementById("scenarioTitle").textContent =
  currentScenario?.title || elScenario().selectedOptions[0]?.textContent || "Scenario";


/* ---------- UI helpers ---------- */

function playAudioCue(urlOrNull, ttsFallback) {
  // Stop any previous cue
  if (playingAudio) {
    try { playingAudio.pause(); } catch (_) {}
    playingAudio = null;
  }
  if (urlOrNull) {
    try {
      const a = new Audio(urlOrNull);
      a.play().catch(() => ttsFallback && speak(ttsFallback));
      playingAudio = a;
      return;
    } catch { /* fall back */ }
  }
  if (ttsFallback) speak(ttsFallback);
}


function getScenarioAudio() {
  const a = currentScenario?.audio || {};
  return {
    retry1:   a.retry1   || DEFAULT_RETRY1_AUDIO,
    retry2:   a.retry2   || DEFAULT_RETRY2_AUDIO,
    thirdFail:a.thirdFail|| DEFAULT_THIRD_FAIL_AUDIO,
    success:  a.success  || DEFAULT_SUCCESS_AUDIO,   // <-- NEW
  };
}

function setQuestion(t) { elQ().textContent = t || ""; }
function setLiveTranscript(t) { elLive().textContent = t || ""; }
function setTypedEnabled(on) { elType().disabled = elSubmit().disabled = !on; }
function setControlsEnabled(on) {
  elRec().disabled = !on;
  elStop().disabled = !on || !streaming;
  elScenario().disabled = !on || streaming;
  setTypedEnabled(false);
}
function resetProgressUI() {
  elChecklist().innerHTML = "";
  elProgress().textContent = "0 / 0 correct";
}
function updateProgressUI() { elProgress().textContent = `${correctCount} / ${turns.length} correct`; }
function addChecklistItem(i, text) {
  const li = document.createElement("li");
  li.dataset.turn = String(i);
  li.innerHTML = `<span class="mark">•</span> ${text}`;
  elChecklist().appendChild(li);
}
function markChecklist(i, ok) {
  const li = elChecklist().querySelector(`li[data-turn="${i}"]`);
  if (!li) return;
  const m = li.querySelector(".mark");
  m.textContent = ok ? "✓" : "✗";
  li.style.color = ok ? "#0a0" : "#c00";
}

/* ---------- ring buffer ---------- */
function ringWriteFrame(fa320) {
  const N = fa320.length, cap = ring.length, tail = cap - ringWrite;
  if (N <= tail) ring.set(fa320, ringWrite);
  else { ring.set(fa320.subarray(0, tail), ringWrite); ring.set(fa320.subarray(tail), 0); }
  ringWrite = (ringWrite + N) % cap;
  ringFilled = Math.min(cap, ringFilled + N);
}
function ringReadWindow() {
  const cap = ring.length;
  if (ringFilled === 0) return new Float32Array(0);
  if (ringFilled < cap) return ring.slice(0, ringFilled);
  const out = new Float32Array(cap), tail = cap - ringWrite;
  out.set(ring.subarray(ringWrite), 0);
  out.set(ring.subarray(0, ringWrite), tail);
  return out;
}
function ringClear() { ringWrite = ringFilled = 0; }

function rms(a) { let s=0; for (let i=0;i<a.length;i++) s += a[i]*a[i]; return Math.sqrt(s/Math.max(1,a.length)); }

/* ---------- streaming ---------- */
async function startStreaming() {
  ctx = new (window.AudioContext||window.webkitAudioContext)({ sampleRate:48000 });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  source = ctx.createMediaStreamSource(stream);

  await ctx.audioWorklet.addModule("/worklets/pcm-processor.js");
  workletNode = new AudioWorkletNode(ctx, "pcm-processor", { numberOfInputs:1, numberOfOutputs:0 });
  workletNode.port.onmessage = (ev) => {
    if (ev.data?.type === "pcm16k") {
      const frame = new Float32Array(ev.data.data);
      ringWriteFrame(frame);
      if (rms(frame) > SILENCE_RMS) lastSpeechTs = performance.now();
    }
  };
  source.connect(workletNode);

  lastSpeechTs = recordStart = performance.now();
  ringClear();
  streaming = true;
  setTypedEnabled(false);
  elRec().disabled = true; elStop().disabled = false;

  decodeTimer = setInterval(async () => {
    const now = performance.now();
    if (now - recordStart >= MAX_RECORD_SEC * 1000) { await stopStreaming(true); return; }
    const buf = ringReadWindow();
    if (buf.length < 16000) return;
    const text = await moonshine.generate(buf);
    setLiveTranscript(text);
    if (text && (now - lastSpeechTs) > SILENCE_FINALIZE_MS) await stopStreaming(true);
  }, DECODE_INTERVAL_MS);
}

async function stopStreaming(finalize=false) {
  if (!streaming && !finalize) return;
  streaming = false;

  if (decodeTimer) { clearInterval(decodeTimer); decodeTimer = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (source) { source.disconnect(); source = null; }
  if (ctx) { await ctx.close(); ctx = null; }

  elRec().disabled = false;
  elStop().disabled = true;

  if (!finalize) return;

  // Final decode -> auto-"submit"
  const buf = ringReadWindow();
  ringClear();

  let finalText = "";
  try {
    finalText = buf.length ? (await moonshine.generate(buf)) : "";
  } catch (e) {
    console.error("final decode error:", e);
  }

  // Populate typed field and trigger the same path as a manual submit
  elType().value = finalText || "";
  // Disable then re-enable to ensure the click is allowed
  elSubmit().disabled = false;
  elSubmit().click();
}


/* ---------- evaluation & flow ---------- */
function normalize(s) { return (s||"").toLowerCase().replace(/[^\w\s']/g," ").replace(/\s+/g," ").trim(); }


function isCorrectAnswer(text, turn) {
  const t = normalize(text);

  // 1) Accept list: any phrase match wins
  if (Array.isArray(turn.accept) && turn.accept.length) {
    if (turn.accept.some(p => t.includes(normalize(p)))) return true;
  }

  // 2) Keywords: need >= threshold hits (substring matches)
  if (Array.isArray(turn.keywords) && turn.keywords.length) {
    const uniqKeywords = [...new Set(turn.keywords.map(normalize))].filter(Boolean);
    const hits = uniqKeywords.reduce((n, kw) => n + (t.includes(kw) ? 1 : 0), 0);

    // If there are fewer than 3 keywords, require all of them; otherwise require >=3
  const scenarioMin = currentScenario?.keywordsMinMatch ?? KEYWORD_MIN_MATCH;
  const turnMin = turn?.keywordsMinMatch ?? scenarioMin;
  const threshold = Math.min(turnMin, uniqKeywords.length);

    if (hits >= threshold) return true;
  }

  // 3) Canonical: relaxed exact match
  if (turn.canonical && normalize(turn.canonical) === t) return true;

  return false;
}


function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1; u.pitch = 1;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

function onAttemptFinished(transcribed) {
  // Show what we heard; allow manual edit+submit too
  setLiveTranscript(transcribed);
  elType().value = transcribed;
  setTypedEnabled(true);

  attemptsThisTurn += 1;

  const turn = turns[turnIdx];
  const ok = isCorrectAnswer(transcribed, turn);
  const cues = getScenarioAudio();

  if (ok) {
    correctCount += 1;
    markChecklist(turnIdx, true);
    updateProgressUI();
    playAudioCue(getScenarioAudio().success, "Correct.");  // TTS fallback if you want a spoken "Correct."
    nextTurn();
    return;
  }

  // Wrong answers
  if (attemptsThisTurn === 1) {
    playAudioCue(cues.retry1, "Not quite. Try again.");
    return; // stay on same turn; user may re-record or type and submit
  }

  if (attemptsThisTurn === 2) {
    playAudioCue(cues.retry2, "Almost. Try once more.");
    return;
  }

  // Third strike: play a different cue, reveal canonical, mark fail, and move on
  playAudioCue(cues.thirdFail, "Let's move on.");
  markChecklist(turnIdx, false);
  updateProgressUI();

 if (turn.canonical) {
   // 1) Speak it (as before)
   speak(`The correct answer is: ${turn.canonical}`);

   // 2) SHOW it temporarily in the live transcript area
   setLiveTranscript(`Correct: ${turn.canonical}`);

   // 3) Persist it under this turn in the checklist for later review
   const li = document.querySelector(`#checklist li[data-turn="${turnIdx}"]`);
   if (li && !li.querySelector('.canonical')) {
     const reveal = document.createElement('div');
     reveal.className = 'canonical';
     reveal.style.opacity = '0.8';
     reveal.style.fontStyle = 'italic';
     reveal.textContent = `Correct: ${turn.canonical}`;
     li.appendChild(reveal);
   }
 }
 // Give the user a moment to read, then advance
 setTimeout(() => nextTurn(), 1200);
}


function nextTurn() {
  setTypedEnabled(false);
  setLiveTranscript("");
  attemptsThisTurn = 0;
  turnIdx += 1;

  if (turnIdx >= turns.length) {
    setQuestion("🎬 Scenario complete.");
    speak("Scenario complete.");
    setControlsEnabled(true);
    return;
  }
  const t = turns[turnIdx];
  setQuestion(t.question || `Turn ${turnIdx+1}`);
  speak(t.question || "");
}

/* ---------- scenarios ---------- */
async function loadScenarioIndex() {
  const r = await fetch(SCENARIO_INDEX_URL);
  if (!r.ok) throw new Error("Failed to load scenario index");
  return r.json();
}
async function loadScenarioById(id, idx) {
  const item = idx.find(x => x.id === id) || idx[0];
  const r = await fetch(item.file);
  if (!r.ok) throw new Error("Failed to load scenario file");
  const data = await r.json();
  data.turns = Array.isArray(data.turns) ? data.turns : [];
  return data;
}
function initChecklist(ts) {
  elChecklist().innerHTML = "";
  ts.forEach((t,i) => addChecklistItem(i, t.question || `Turn ${i+1}`));
  correctCount = 0; updateProgressUI();
}




/* ---------- boot ---------- */

window.onload = async () => {
  setControlsEnabled(false);
  resetProgressUI();

  // Load ASR model
  modelName = document.getElementById("models").value
  setQuestion("Loading " + modelName + "...")
  moonshine = new Moonshine(modelName)
  moonshine.loadModel().then(() => {
    setQuestion("")
    setControlsEnabled(true)
  });
  

  models.onchange = async function(e) {
    var selection = document.getElementById("models").value
    if (selection != modelName) {
      setControlsEnabled(false)
      modelName = selection
      setQuestion("Loading " + modelName + "...")
      var moonshine = new Moonshine(modelName)
      moonshine.loadModel().then(() => {
        setQuestion("")
        setControlsEnabled(true)
      });
    }
  }

  // Load scenarios & populate select
  let idx = [];
  try {
    idx = await loadScenarioIndex();
    const sel = elScenario();
    sel.innerHTML = "";
    for (const item of idx) {
      const o = document.createElement("option");
      o.value = item.id; o.textContent = item.title || item.id;
      sel.appendChild(o);
    }
  } catch (e) {
    console.error(e);
    alert("Could not load scenarios. Check /public/scenarios/");
  }

  // Select default scenario
  if (idx.length) {
    currentScenario = await loadScenarioById(elScenario().value || idx[0].id, idx);
    turns = currentScenario.turns; turnIdx = 0; attemptsThisTurn = 0; correctCount = 0;
    initChecklist(turns);
    if (turns.length) { setQuestion(turns[0].question || "Turn 1"); speak(turns[0].question || ""); }
  }

  setControlsEnabled(true);
  currentScenario = await loadScenarioById(elScenario().value || idx[0].id, idx);
  turns = currentScenario.turns; turnIdx = 0; attemptsThisTurn = 0; correctCount = 0;
  document.getElementById("scenarioTitle").textContent =
  currentScenario?.title || elScenario().selectedOptions[0]?.textContent || "Scenario";
  initChecklist(turns);
  // Handlers
  elScenario().addEventListener("change", async () => {
    if (streaming) return;
    setControlsEnabled(false);
    currentScenario = await loadScenarioById(elScenario().value, idx);
    turns = currentScenario.turns; turnIdx = 0; attemptsThisTurn = 0; correctCount = 0;
    document.getElementById("scenarioTitle").textContent =
    currentScenario?.title || elScenario().selectedOptions[0]?.textContent || "Scenario";
    initChecklist(turns);
    if (turns.length) { setQuestion(turns[0].question || "Turn 1"); speak(turns[0].question || ""); }
    else setQuestion("This scenario has no turns.");
    setControlsEnabled(true);
  });

  elRec().addEventListener("click", () => startStreaming());
  elStop().addEventListener("click", () => stopStreaming(true));
  elSubmit().addEventListener("click", () => {
    const txt = elType().value || "";
    setTypedEnabled(false);
    onAttemptFinished(txt);
  });
};
