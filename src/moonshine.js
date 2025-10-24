// moonshine.js
import * as ort from 'onnxruntime-web';
import llamaTokenizer from 'llama-tokenizer-js';
// These imports produce hashed asset URLs like /assets/xxx.wasm
// ---------- utils ----------
function argMax(array) {
  return [].map.call(array, (x, i) => [x, i]).reduce((r, a) => (a[0] > r[0] ? a : r))[1];
}
const BASE = (import.meta?.env?.BASE_URL) || '/';   // robust if you deploy under a subpath





// then create sessions…

// Build the four URLs for a given model name ("tiny" | "base")
function modelFileList(modelName) {
  const dir = `${BASE}moonshine/${modelName}`;
  return [
    { key: 'preprocess',      url: `${dir}/preprocess.ort` },
    { key: 'encode',          url: `${dir}/encode.ort` },
    { key: 'uncached_decode', url: `${dir}/uncached_decode.ort` },
    { key: 'cached_decode',   url: `${dir}/cached_decode.ort` },
  ];
}

// Stream a fetch with progress + Cache API (so future loads are instant)
async function fetchWithProgress(url, onProgress) {
  const cache = await caches.open('moonshine-models-v1');
  let res = await cache.match(url);
  if (!res) {
    // Use normal fetch but allow browser/http caches too
    res = await fetch(url, { cache: 'force-cache' });
    if (res.ok) {
      // Stash a copy so next visit is instant
      cache.put(url, res.clone());
    }
  }
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  // If the server doesn't provide a readable stream, just return arrayBuffer
  const reader = res.body?.getReader?.();
  if (!reader) return await res.arrayBuffer();

  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress && total) onProgress(received / total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out.buffer;
}

export default class Moonshine {
  constructor(model_name) {
    this.model_name = model_name;
    this.model = {
      preprocess: undefined,
      encode: undefined,
      uncached_decode: undefined,
      cached_decode: undefined
    };
  }
  /**
   * Load all four .ort graphs in parallel with progress and caching.
   * @param {(info:{msg?:string,pct?:number})=>void} onProgress optional progress hook
   */
  async loadModel(onProgress) {
          // 1) Map canonical filenames to the emitted URLs

    // 3) SIMD is fine either way (Chrome supports SIMD), but you can leave true.
    // Configure ORT WASM runtime (adjust wasmPaths if you host /ort/*.wasm)
    // ort.env.wasm.wasmPaths = `${BASE}ort`;  // uncomment if you copy ORT wasm to /public/ort
    ort.env.wasm.simd = true;                 // enable SIMD when available

    // ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1); // optional

    const files = modelFileList(this.model_name);

    // Progress bookkeeping
    const totals = new Map(files.map(f => [f.url, 0]));
    const dones  = new Map(files.map(f => [f.url, 0]));
    const report = (msg, pct) => onProgress?.({ msg, pct });

    // Try to HEAD to get content-lengths (optional but improves progress accuracy)
    await Promise.all(files.map(async f => {
      try {
        const h = await fetch(f.url, { method: 'HEAD' });
        const len = Number(h.headers.get('content-length')) || 0;
        totals.set(f.url, len);
      } catch { /* some servers disallow HEAD; it's fine */ }
    }));

    // Helper to recompute overall % from per-file bytes
    const recalcOverall = () => {
      const totalBytes = [...totals.values()].reduce((a,b)=>a+b, 0);
      if (totalBytes > 0) {
        const doneBytes = [...dones.values()].reduce((a,b)=>a+b, 0);
        report(`Loading ${this.model_name}…`, Math.round((doneBytes / totalBytes) * 100));
      } else {
        // Fallback: count completed files equally
        const perFile = files.map(f => (dones.get(f.url) > 0 ? 1 : 0)).reduce((a,b)=>a+b, 0);
        report(`Loading ${this.model_name}…`, Math.round((perFile / files.length) * 100));
      }
    };

    report(`Loading ${this.model_name}…`, 1);

    // Fetch all four in parallel, streaming progress into the totals map
    const buffers = await Promise.all(files.map(f =>
      fetchWithProgress(f.url, frac => {
        const total = totals.get(f.url) || 0;
        dones.set(f.url, total ? Math.floor(frac * total) : 1);
        recalcOverall();
      })
    ));

    // Create ORT sessions from in-memory bytes (avoids ORT refetch)
    const sessionOption = { executionProviders: ['wasm'] }; // 'cpu' is not a browser EP
    const sessionsByKey = {};
    for (let i = 0; i < files.length; i++) {
      sessionsByKey[files[i].key] = await ort.InferenceSession.create(buffers[i], sessionOption);
      report(`Loaded ${files[i].key}`, undefined);
    }

    this.model = sessionsByKey;
    report('Ready', 100);
    console.log(`${this.model_name} loaded`);
  }

  async generate(audio) {
    if (this.model.preprocess && this.model.encode && this.model.uncached_decode && this.model.cached_decode) {
      const max_len = Math.trunc((audio.length / 16000) * 6);

      // 1) preprocess
      const preprocessed = await this.model.preprocess.run({
        args_0: new ort.Tensor("float32", audio, [1, audio.length])
      });

      // 2) encode
      const encInput = new ort.Tensor("float32", preprocessed["sequential"]["data"], preprocessed["sequential"]["dims"]);
      const encLen   = new ort.Tensor("int32",   [preprocessed["sequential"]["dims"][1]], [1]);
      const context  = await this.model.encode.run({ args_0: encInput, args_1: encLen });

      // find layer_norm key
      let layer_norm_key = "";
      for (const key in context) { if (key.startsWith("layer_norm")) { layer_norm_key = key; break; } }

      // 3) first decode (uncached)
      let seq_len = 1;
      let tokens = [1];
      let decode = await this.model.uncached_decode.run({
        args_0: new ort.Tensor("int32", [[1]], [1, 1]),
        args_1: new ort.Tensor("float32", context[layer_norm_key]["data"], context[layer_norm_key]["dims"]),
        args_2: new ort.Tensor("int32", [seq_len], [1])
      });

      // 4) subsequent cached decodes
      for (let i = 0; i < max_len; i++) {
        const logits = decode["reversible_embedding"]["data"];
        const next_token = argMax(logits);
        if (next_token === 2) break;  // EOS

        tokens.push(next_token);
        seq_len += 1;

        const feed = {
          args_0: new ort.Tensor("int32", [[next_token]], [1, 1]),
          args_1: new ort.Tensor("float32", context[layer_norm_key]["data"], context[layer_norm_key]["dims"]),
          args_2: new ort.Tensor("int32", [seq_len], [1])
        };

        // Carry over KV/state tensors
        let j = 3;
        Object.keys(decode).forEach(key => {
          if (!key.startsWith("reversible")) {
            feed["args_" + j] = decode[key];
            j += 1;
          }
        });
        decode = await this.model.cached_decode.run(feed);
      }

      return llamaTokenizer.decode(tokens);
    } else {
      console.warn("Tried to call Moonshine.generate() before the model was loaded.");
      return "";
    }
  }
}
