// Kokoro, one layer at a time.
//
// **This exists because debugging it end to end was the wrong shape.** Five layers deep — worker
// → service worker → offscreen document → HeadTTS → its worker → transformers.js — and only the
// outermost one reports, so every failure arrived as "connection failed" regardless of cause.
// Three rounds were spent establishing which layer, and each answer was one sentence from a
// `catch` that already had it.
//
// It runs inside the real extension rather than as a standalone page, because the things most
// likely to break are precisely the ones a standalone page would get wrong: the CSP, the
// origin, `chrome-extension://` module resolution, and what is actually in the cache.
//
// Each step is the smallest thing that can fail alone, in the order the engine needs them.

import { ALL, weightsStatus } from './weights.js';
import { hasWebGPU } from './tts.js';
import { MODEL_REPO, VOICES_BASE, DTYPE } from './weights.js';

const steps = document.getElementById('steps');

function report(what, ok, detail) {
  const row = document.createElement('div');
  row.className = `step ${ok ? 'ok' : 'bad'}`;
  const dot = document.createElement('div');
  dot.className = 'dot';
  dot.textContent = ok ? '✓' : '!';
  const body = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'what';
  title.textContent = what;
  const text = document.createElement('div');
  text.className = 'detail';
  text.textContent = detail ?? '';
  body.append(title, text);
  row.append(dot, body);
  steps.append(row);
  return ok;
}

/** Runs one step, and never lets a throw stop the ones after it. */
async function step(what, run) {
  try {
    const detail = await run();
    return report(what, true, detail);
  } catch (error) {
    report(what, false, `${error?.message ?? error}\n${error?.stack ?? ''}`.trim());
    return false;
  }
}

document.getElementById('run').addEventListener('click', async () => {
  steps.textContent = '';
  document.getElementById('run').disabled = true;

  // 1. The files. Everything below needs them, and "not downloaded" would otherwise surface as
  //    a confusing failure three layers further in.
  const filesOk = await step('Weights present and verified', async () => {
    const { state, have, want } = await weightsStatus();
    if (state !== 'ready') throw new Error(`${have} of ${want} files — open Settings and download`);
    return `${want} files\n${ALL.map((f) => f.id).join(', ')}`;
  });

  // 2. WebGPU. Asked for an adapter rather than trusting `navigator.gpu` to exist, because on
  //    some machines the object is there and the adapter is not.
  await step('WebGPU adapter', async () => {
    if (!(await hasWebGPU())) throw new Error('no adapter — Kokoro would be too slow to use');
    const info = await (await navigator.gpu.requestAdapter())?.requestAdapterInfo?.();
    return info ? `${info.vendor ?? '?'} ${info.architecture ?? ''}`.trim() : 'adapter acquired';
  });

  // 3. transformers.js as a module. **The step that was failing**, and it failed on the
  //    bare specifier `onnxruntime-web/webgpu` in the `.web.` build — a bundler's job, not a
  //    browser's. Reported here as itself rather than as "importing modules failed".
  const tf = await step('transformers.js imports', async () => {
    const url = chrome.runtime.getURL('vendor/transformers/transformers.min.js');
    const mod = await import(url);
    const wanted = ['StyleTextToSpeech2Model', 'AutoTokenizer', 'env'];
    const missing = wanted.filter((k) => !(k in mod));
    if (missing.length) throw new Error(`loaded but missing ${missing.join(', ')}`);
    return `${Object.keys(mod).length} exports`;
  });

  // 4. The WASM binary is reachable at the path the worker points ONNX Runtime at.
  //
  //    **The asyncify build, which is the one `ort.webgpu` actually loads.** This checked the
  //    `jsep` pair first, found it, reported green — and the backend then failed looking for
  //    asyncify. A reachability check against a file nothing loads is worse than no check: it
  //    is a green tick for the wrong thing.
  await step('ONNX Runtime WASM reachable', async () => {
    const url = chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return `${Math.round((await res.blob()).size / 1e6)} MB at ${url.split('/').slice(-1)[0]}`;
  });

  // 5. HeadTTS as a module, before any worker is started.
  const headtts = await step('HeadTTS imports', async () => {
    const mod = await import(chrome.runtime.getURL('vendor/headtts/headtts.mjs'));
    if (!mod.HeadTTS) throw new Error('loaded but exports no HeadTTS');
    return 'HeadTTS exported';
  });

  if (!filesOk || !tf || !headtts) {
    report('Stopped', false, 'A step above has to pass before the engine can start.');
    document.getElementById('run').disabled = false;
    return;
  }

  // 6. The worker starts and reaches ready — which means the model, the tokenizer and the
  //    dictionary all loaded from the cache without a single network request.
  let engine = null;
  const connected = await step('Worker connects and loads the model', async () => {
    const { HeadTTS } = await import(chrome.runtime.getURL('vendor/headtts/headtts.mjs'));
    engine = new HeadTTS({
      endpoints: ['webgpu'],
      transformersModule: chrome.runtime.getURL('vendor/transformers/transformers.min.js'),
      dictionaryURL: chrome.runtime.getURL('dictionaries'),
      voiceURL: VOICES_BASE,
      model: MODEL_REPO,
      dtypeWebgpu: DTYPE,
      languages: ['en-us'],
    });
    const started = performance.now();
    await engine.connect();
    return `ready in ${Math.round(performance.now() - started)} ms`;
  });
  if (!connected) { document.getElementById('run').disabled = false; return; }

  // 7. Actual audio. The only step that proves the thing works rather than merely loads.
  await step('Synthesises and plays', async () => {
    await engine.setup({ voice: 'bm_george', language: 'en-us', audioEncoding: 'wav' });
    const chunks = [];
    await engine.synthesize({ input: 'Hello. This is Kokoro, running on your machine.' },
      (m) => { if (m?.data?.audio) chunks.push(m.data.audio); });
    if (!chunks.length) throw new Error('connected and produced no audio');

    // **Every chunk, in order.** HeadTTS splits on sentences, so playing `chunks[0]` alone
    // produced "Hello." and stopped — which read as the engine truncating when it had in fact
    // synthesised all 5.2 seconds. `kokoro.js` already chains them; this had not.
    const ctx = new AudioContext();
    let at = ctx.currentTime;
    for (const buffer of chunks) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(at);
      at += buffer.duration;
    }
    const seconds = chunks.reduce((n, b) => n + b.duration, 0).toFixed(1);
    return `${chunks.length} chunk(s), ${seconds}s — playing now`;
  });

  document.getElementById('run').disabled = false;
});
