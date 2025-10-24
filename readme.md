Here’s a **drop-in README.md** tailored to your repo — wired for Vite + vanilla JS, JSON dialogue trees, and an in-browser WASM speech model. It also documents the files already in your project (Vite config, Dockerfile, Fly.io config, nginx) so new contributors can hit the ground running.

---

# EMT Trainer (Vite + Vanilla JS)

A **browser-only** trainer for staged dialogue recall: users **speak** their answers, a **WASM voice-to-text (V2T)** model transcribes locally, and the app matches the utterance to the **current dialogue node** defined in JSON. Advance when you say the right thing — no servers or cloud speech APIs required.

* Fast dev/build via **Vite**. ([GitHub][1])
* Ships with **Docker** + **Nginx** static hosting and **Fly.io** app config. ([GitHub][2])

---

## Features

* **JSON dialogue trees** with prompts, expected utterances, keyword/fuzzy/semantic matching, and variable capture.
* **Local V2T (WASM)**: swap in Vosk-WASM or whisper.cpp-WASM; user audio never leaves the browser tab.
* **Deterministic state machine**: advance on first passing expectation; fallbacks + hints on miss.
* **Persistence**: resume from last node via `localStorage`.
* **Deploy anywhere**: `vite build` for static files, or use the included **Dockerfile** and **fly.toml**. ([GitHub][2])

---

## Project Layout

```
emt-trainer/
├─ public/                 # static assets, model files live here (you add them)
├─ src/                    # app code (UI, matcher, state, V2T adapters)
├─ index.html              # Vite entrypoint (vanilla JS mount)             ← present
├─ vite.config.js          # Vite config                                     ← present
├─ package.json            # scripts & deps                                   ← present
├─ downloader.js           # optional helper for fetching model files         ← present
├─ nginx.conf              # production static hosting in container           ← present
├─ Dockerfile              # multi-stage build, serves dist/ with nginx       ← present
└─ fly.toml                # Fly.io app config                                ← present
```

(See repository root for these files.) ([GitHub][3])

---

## Quickstart

### Requirements

* Node.js 18+
* One WASM speech model placed under `public/models/` (see **Voice Model Setup**)

### Install & Run (dev)

```bash
# clone your repo
git clone https://github.com/Homer-Mctavish/emt-trainer
cd emt-trainer

# install deps (choose one)
npm install  # or: pnpm install / yarn

# run dev server
npm run dev
# open the printed http://localhost:5173 URL
```

### Build

```bash
npm run build
npm run preview  # serve the built /dist locally for a quick check
```

---

## Voice Model Setup (WASM)

Choose one engine and copy its WASM + weights into `public/models/`:

* **Vosk (WASM)** – smaller, quick to load for constrained vocabularies.
  Example layout:

  ```
  public/models/
    vosk.wasm
    model-small/
      conf/
      am/
      ...
  ```
* **whisper.cpp (WASM build)** – higher accuracy; larger models (use a quantized `.bin`).
  Example layout:

  ```
  public/models/
    ggml-base.en-q5_1.bin
    whisper.wasm
  ```

> Tip: if you keep a helper fetcher, document how to run `node downloader.js` to pull models into `public/models/`. (The repo already includes `downloader.js` for this purpose.) ([GitHub][4])

---

## Configuration

Create `src/config.js` (or use your existing one) to toggle engines and thresholds:

```js
export default {
  locale: 'en-US',
  model: {
    engine: 'vosk',          // 'vosk' | 'whisper'
    path: '/models/',
    whisper: { modelFile: 'ggml-base.en-q5_1.bin', beamSize: 5 },
    vosk:    { modelDir: 'model-small' }
  },
  matching: {
    strategies: ['exact', 'fuzzy', 'keywords'],   // add 'semantic' if you ship embeddings
    fuzzy:    { method: 'jaro-winkler', threshold: 0.86 },
    keywords: { minHits: 2 },
    semantic: { enabled: false, threshold: 0.78 }
  },
  ui: { showWaveform: true, showConfidence: true },
  persistenceKey: 'emt-trainer:last'
};
```

---

## Dialogue JSON Schema

Put dialogues in `src/data/` (or `public/dialogues/`) and load them at runtime.

```json
{
  "id": "emt-demo-001",
  "title": "Airway Assessment Warmup",
  "version": "1.0.0",
  "locale": "en-US",
  "start": "greet",
  "settings": {
    "normalize": { "lowercase": true, "stripDiacritics": true, "removePunctuation": true },
    "matching":  { "strategy": ["exact","fuzzy","keywords"], "fuzzy": { "method": "jaro-winkler", "threshold": 0.86 }, "keywords": { "minHits": 1 } },
    "timeouts":  { "speechMs": 12000, "silenceMs": 1500 }
  },
  "nodes": [
    {
      "id": "greet",
      "role": "system",
      "prompt": "Ready to begin the airway assessment scenario?",
      "expect": [
        { "utterances": ["yes","ready","let's start"], "next": "scene-brief", "hints": ["Try saying 'yes'"] },
        { "utterances": ["no","later"], "next": "exit" }
      ]
    },
    {
      "id": "scene-brief",
      "role": "system",
      "prompt": "You're first on scene. What's your first step?",
      "expect": [
        { "keywords": ["scene","safe"], "next": "primary-survey" },
        { "utterances": ["scene safe","ensure scene safety"], "next": "primary-survey" }
      ]
    },
    {
      "id": "primary-survey",
      "role": "system",
      "prompt": "Proceed.",
      "expect": [
        { "keywords": ["avpu","airway","breathing","circulation"], "next": "end" }
      ]
    },
    { "id": "end",  "role": "system", "prompt": "Good work. Scenario complete." },
    { "id": "exit", "role": "system", "prompt": "Okay, try again later." }
  ]
}
```

**Field notes**

* `start`: initial node id.
* `nodes[].expect[]`: ordered expectations; **first match wins**.
* Matching types supported:

  * `utterances` → exact/normalized text
  * `keywords`   → requires `minHits`
  * optional `semantic: true` if you ship a tiny embedding model (WASM)
* `onCapture.storeAs` (optional) lets you bind captured text (e.g., a name) and reuse it: `"Thanks, {{userName}}"`.

---

## Matching Flow (high-level)

1. Normalize candidate & transcript (lowercase, strip punctuation/diacritics).
2. Try **exact** match → **fuzzy** (e.g., Jaro-Winkler) → **keyword** hits → optional **semantic** similarity.
3. On pass, transition to `next`; on fail/timeout, show `hints` or branch to a fallback node.

---
## Deployment

### Static Build (any static host)

```bash
npm run build
# deploy the /dist folder to Netlify, GitHub Pages, S3+CloudFront, etc.
```

### Docker (Nginx)

A multi-stage Dockerfile is provided; it builds with Vite, then serves with Nginx. ([GitHub][2])

```bash
docker build -t emt-trainer .
docker run -p 8080:80 emt-trainer
# open http://localhost:8080
```

> Ensure your model files are available at runtime (e.g., COPY them into the image under `/usr/share/nginx/html/models` or mount a volume).

### Fly.io

A `fly.toml` is included for easy deployment to Fly.io. ([GitHub][5])

```bash
# once authenticated with flyctl:
fly launch   # (or edit fly.toml first)
fly deploy
```

---

## Privacy & Security

* Audio stays **in-browser**; the V2T model runs as WASM in the page.
* No analytics/telemetry are enabled by default — add them deliberately if needed.

---

## Authoring Tips

* Keep prompts **short** and expectations **generous** (list paraphrases).
* Prefer **keywords** to allow natural speech; layer with **fuzzy** matching.
* Provide **hints** after a miss to teach the expected phrase.
* Validate critical captures (e.g., regex for names/IDs) before advancing.
---

## License
The MIT License (MIT)
Copyright © 2025 homer-mctavish

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
