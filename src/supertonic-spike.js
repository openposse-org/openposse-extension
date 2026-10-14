// Supertonic 3, measured inside the extension before anything is built on it.
//
// A developer page, left out of store builds like the Kokoro spike beside it. It answers what the
// archive's own numbers cannot: how fast Supertonic speaks from an extension page on this
// machine's GPU, how each language sounds, and whether it keeps up while Kokoro is loaded in the
// offscreen document at the same time. Same origin and same GPU as the offscreen document, so
// the timings carry over; nothing in the product changes.
//
// The weights follow the project's rule for models: fetched only when the button is pressed,
// from a pinned revision, and checked against a SHA-256 written below before they are kept.
//
// Logs carry event types and timings only, never the text being spoken.

import * as ort from 'onnxruntime-web/webgpu';
import { Style, TextToSpeech, UnicodeProcessor, AVAILABLE_LANGS } from './supertonic/helper.js';
import { digest, ensureAccess, VOICES as KOKORO_VOICES } from './weights.js';

const REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const BASE = `https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/${REVISION}/`;
const CACHE = 'openposse-supertonic-spike-v1';

const MODELS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];

/** Every file the spike uses, with the SHA-256 it must have. Sizes are for the progress line. */
const FILES = [
  { path: 'onnx/duration_predictor.onnx', size: 3700147, sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' },
  { path: 'onnx/text_encoder.onnx', size: 36416150, sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' },
  { path: 'onnx/vector_estimator.onnx', size: 256534781, sha256: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c' },
  { path: 'onnx/vocoder.onnx', size: 101424195, sha256: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba' },
  { path: 'onnx/tts.json', size: 8253, sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09' },
  { path: 'onnx/unicode_indexer.json', size: 277676, sha256: '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f' },
  { path: 'voice_styles/F1.json', size: 292046, sha256: 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2' },
  { path: 'voice_styles/F2.json', size: 292423, sha256: '7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6' },
  { path: 'voice_styles/F3.json', size: 290794, sha256: '12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab' },
  { path: 'voice_styles/F4.json', size: 291808, sha256: 'c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b' },
  { path: 'voice_styles/F5.json', size: 291479, sha256: '45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d' },
  { path: 'voice_styles/M1.json', size: 291748, sha256: 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b' },
  { path: 'voice_styles/M2.json', size: 292055, sha256: 'b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50' },
  { path: 'voice_styles/M3.json', size: 290198, sha256: 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b' },
  { path: 'voice_styles/M4.json', size: 291522, sha256: 'ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303' },
  { path: 'voice_styles/M5.json', size: 291469, sha256: 'dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2' },
];

/** One sentence each, shaped like an assistant's answer, numbers included: they are the hard part. */
const SENTENCES = [
  { lang: 'en', text: 'The pipeline total is 4.2 million dollars, and twelve deals are still missing an owner this quarter.' },
  { lang: 'de', text: 'Die Pipeline umfasst 4,2 Millionen Euro, und zwölf Abschlüsse haben in diesem Quartal noch keinen Verantwortlichen.' },
  { lang: 'fr', text: "Le pipeline atteint 4,2 millions d'euros, et douze affaires n'ont toujours pas de responsable ce trimestre." },
];

// The runtime files are the ones transformers.js already ships, byte for byte (see helper.js).
// One thread: an extension page is not cross-origin isolated, so there is no SharedArrayBuffer.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/');
ort.env.wasm.numThreads = 1;

const $ = (id) => document.getElementById(id);
const buttons = ['download', 'forget', 'load', 'kokoro', 'run', 'own-run', 'kokoro-run', 'hear', 'copy'].map($);

let tts = null;
let sessions = [];
let loaded = null;          // { backend, ms, gpu }
let kokoro = 'not asked';
const rows = [];

function say(element, text, bad = false) {
  element.textContent = text;
  element.classList.toggle('bad', bad);
}

/** Runs one action at a time: ONNX sessions are not re-entrant, and two downloads would race. */
async function busy(element, action) {
  for (const button of buttons) button.disabled = true;
  try {
    await action();
  } catch (error) {
    console.warn('[openposse] supertonic spike step failed –', error?.message ?? error);
    say(element, error?.message ?? String(error), true);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function cached(path) {
  const response = await (await caches.open(CACHE)).match(BASE + path);
  if (!response) throw new Error(`${path} is not downloaded yet. Press Download first.`);
  return response;
}

// ── 1. The weights ───────────────────────────────────────────────────────────────────────────

$('download').addEventListener('click', async () => {
  // First, before anything else is awaited: the permission prompt needs this click's gesture.
  const granted = await ensureAccess();
  await busy($('download-status'), async () => {
    if (!granted) {
      throw new Error('Nothing downloaded: access to huggingface.co and its download host was not granted.');
    }
    const cache = await caches.open(CACHE);
    const total = FILES.reduce((sum, file) => sum + file.size, 0);
    let done = 0;
    for (const file of FILES) {
      const url = BASE + file.path;
      if (await cache.match(url)) {
        done += file.size;
        continue;
      }
      say($('download-status'), `Downloading ${file.path} (${mb(file.size)}) · ${mb(done)} of ${mb(total)}`);
      let response;
      try {
        response = await fetch(url);
      } catch (error) {
        throw new Error(`${file.path} could not be fetched: ${error?.message ?? error}`);
      }
      if (!response.ok) throw new Error(`${file.path} could not be fetched: HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const hash = await digest(buffer);
      if (hash !== file.sha256) {
        throw new Error(`${file.path} did not match its pinned SHA-256 (got ${hash.slice(0, 12)}…), so it was thrown away.`);
      }
      await cache.put(url, new Response(buffer));
      done += file.size;
    }
    say($('download-status'), `All ${FILES.length} files downloaded and verified · ${mb(total)}`);
  });
});

$('forget').addEventListener('click', () => busy($('download-status'), async () => {
  await caches.delete(CACHE);
  say($('download-status'), 'Deleted. Nothing of Supertonic is stored now.');
}));

// ── 2. Load ──────────────────────────────────────────────────────────────────────────────────

async function gpuName() {
  if (!navigator.gpu) return 'no WebGPU on this page';
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return 'WebGPU present, but no adapter';
  const { vendor, architecture, description } = adapter.info ?? {};
  return [vendor, architecture, description].filter(Boolean).join(' · ') || 'unnamed adapter';
}

$('load').addEventListener('click', () => busy($('load-status'), async () => {
  const backend = $('backend').value;
  await Promise.all(sessions.map((session) => session.release()));
  sessions = [];
  tts = null;
  loaded = null;

  const gpu = await gpuName();
  const started = performance.now();
  for (const model of MODELS) {
    say($('load-status'), `Loading ${model} on ${backend}…`);
    const bytes = new Uint8Array(await (await cached(`onnx/${model}.onnx`)).arrayBuffer());
    try {
      sessions.push(await ort.InferenceSession.create(bytes, { executionProviders: [backend] }));
    } catch (error) {
      throw new Error(`${model} would not load on ${backend}: ${error?.message ?? error}`);
    }
  }
  const cfgs = await (await cached('onnx/tts.json')).json();
  const indexer = await (await cached('onnx/unicode_indexer.json')).json();
  tts = new TextToSpeech(cfgs, new UnicodeProcessor(indexer), ...sessions);
  loaded = { backend, ms: performance.now() - started, gpu };
  say($('load-status'), `Loaded on ${backend} in ${(loaded.ms / 1000).toFixed(1)} s · GPU: ${gpu} · ${tts.sampleRate} Hz`);
}));

// Kokoro speaks in the offscreen document, through the message Settings' sample button sends, so
// it is loaded and heard exactly as the product loads it and speaks an answer. The outcome comes
// back as `openposse.spoke`, after the speaking has finished, to whichever section asked.
let spokeStatus = $('load-status');

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind !== 'openposse.spoke' || !message.preview) return;
  kokoro = message.ok ? `spoke with ${message.engine}` : `did not speak: ${message.reason ?? 'no reason given'}`;
  const who = message.engine === 'kokoro' ? `Kokoro (${message.voice})` : message.engine ?? 'the offscreen page';
  const system = message.engine === 'system'
    ? ' That was the system voice, so Kokoro did not answer: is it downloaded in Settings, and does this machine have WebGPU?'
    : '';
  say(spokeStatus, message.ok ? `${who} finished speaking.${system}` : `${who} did not speak: ${message.reason ?? 'no reason given'}`,
    !message.ok || message.engine !== 'kokoro');
});

async function askKokoro(text, voice, status) {
  spokeStatus = status;
  const reply = await chrome.runtime.sendMessage({ kind: 'openposse.voice.preview', text, voice });
  if (reply?.ok === false) throw new Error(`The offscreen page did not take it: ${reply.reason ?? 'no reason given'}`);
}

$('kokoro').addEventListener('click', () => busy($('load-status'), async () => {
  kokoro = 'asked';
  await askKokoro('Kokoro is loaded and speaking from the offscreen page.', null, $('load-status'));
  say($('load-status'), 'Asked the offscreen page for a sample, which loads Kokoro. Wait for it to speak, then run.');
}));

// ── 3. Speak ─────────────────────────────────────────────────────────────────────────────────

function option(value) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = value;
  return element;
}
for (const voice of VOICES) $('voice').append(option(voice));
for (const lang of AVAILABLE_LANGS.filter((l) => l !== 'na')) $('own-lang').append(option(lang));
for (const { id } of KOKORO_VOICES) $('kokoro-voice').append(option(id));
$('kokoro-voice').value = 'af_heart';

// Both boxes start with the same English sentence, so the first comparison is one click each.
$('own-text').value = SENTENCES[0].text;
$('kokoro-text').value = SENTENCES[0].text;

async function styleFor(voice) {
  const json = await (await cached(`voice_styles/${voice}.json`)).json();
  const tensor = (part) =>
    new ort.Tensor('float32', Float32Array.from(json[part].data.flat(Infinity)), json[part].dims);
  return new Style(tensor('style_ttl'), tensor('style_dp'));
}

let context = null;
function play(wav, sampleRate) {
  context ??= new AudioContext();
  const buffer = context.createBuffer(1, wav.length, sampleRate);
  buffer.copyToChannel(Float32Array.from(wav), 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  return new Promise((resolve) => {
    source.onended = resolve;
    source.start();
  });
}

function addRow(row) {
  rows.push(row);
  const tr = document.createElement('tr');
  const silent = !(row.peak > 0.01);
  const cells = [
    row.lang, row.backend, row.steps, row.run,
    `${(row.ms / 1000).toFixed(2)} s`, `${row.audio.toFixed(2)} s`, row.rtf.toFixed(2),
    Number.isNaN(row.peak) ? 'NaN' : row.peak.toFixed(3),
  ];
  cells.forEach((text, i) => {
    const td = document.createElement('td');
    td.textContent = String(text);
    if (i === 7 && silent) td.className = 'bad';
    tr.append(td);
  });
  $('results').append(tr);
}

/** One synthesis, timed; the audio only after the clock has stopped. */
async function speak(lang, text, run, style, steps, speed) {
  const started = performance.now();
  const { wav } = await tts.call(text, lang, style, steps, speed);
  const ms = performance.now() - started;
  let peak = 0;
  for (const sample of wav) peak = Math.max(peak, Math.abs(sample));
  const audio = wav.length / tts.sampleRate;
  addRow({ lang, backend: loaded.backend, steps, run, ms, audio, rtf: ms / 1000 / audio, peak });
  return wav;
}

async function runAll(sentences, status) {
  if (!tts) throw new Error('Nothing is loaded yet. Press Load first.');
  const steps = Math.min(32, Math.max(1, Number($('steps').value) || 8));
  const speed = Math.min(2, Math.max(0.5, Number($('speed').value) || 1.05));
  const style = await styleFor($('voice').value);
  for (const { lang, text } of sentences) {
    say(status, `Speaking ${lang}…`);
    // Twice: the first run pays for shader compilation and warm-up, the second is the steady cost.
    const wav = await speak(lang, text, 1, style, steps, speed);
    if ($('play').checked) await play(wav, tts.sampleRate);
    await speak(lang, text, 2, style, steps, speed);
  }
  say(status, `Done · ${sentences.length} sentence${sentences.length === 1 ? '' : 's'}, two runs each.`);
}

$('run').addEventListener('click', () => busy($('run-status'), () => runAll(SENTENCES, $('run-status'))));

$('own-run').addEventListener('click', () => busy($('run-status'), async () => {
  const text = $('own-text').value.trim();
  if (!text) throw new Error('Type a sentence first.');
  await runAll([{ lang: $('own-lang').value, text }], $('run-status'));
}));

$('kokoro-run').addEventListener('click', () => busy($('kokoro-status'), async () => {
  const text = $('kokoro-text').value.trim();
  if (!text) throw new Error('Type something for Kokoro to say first.');
  await askKokoro(text, $('kokoro-voice').value, $('kokoro-status'));
  say($('kokoro-status'), `Sent to Kokoro (${$('kokoro-voice').value}). It is speaking, or loading first.`);
}));

// ── 5. Which languages can Chrome hear? ──────────────────────────────────────────────────────
//
// The same question the offscreen document asks before every turn, `available()` with
// `processLocally: true`, put for each of Supertonic's languages. It answers without downloading
// anything. Chrome keys its packs by locale, so each language tries its usual locales and its
// bare code, and the best answer wins.

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

const LOCALES = {
  en: ['en-US', 'en-GB'], ko: ['ko-KR'], ja: ['ja-JP'], ar: ['ar-SA', 'ar-EG'], bg: ['bg-BG'],
  cs: ['cs-CZ'], da: ['da-DK'], de: ['de-DE'], el: ['el-GR'], es: ['es-ES', 'es-US'],
  et: ['et-EE'], fi: ['fi-FI'], fr: ['fr-FR'], hi: ['hi-IN'], hr: ['hr-HR'], hu: ['hu-HU'],
  id: ['id-ID'], it: ['it-IT'], lt: ['lt-LT'], lv: ['lv-LV'], nl: ['nl-NL'], pl: ['pl-PL'],
  pt: ['pt-BR', 'pt-PT'], ro: ['ro-RO'], ru: ['ru-RU'], sk: ['sk-SK'], sl: ['sl-SI'],
  sv: ['sv-SE'], tr: ['tr-TR'], uk: ['uk-UA'], vi: ['vi-VN'],
};

/** What each answer means to a person, best first. */
const HEARD = {
  available: 'can hear now',
  downloading: 'downloading',
  downloadable: 'could download',
  unavailable: 'cannot hear',
};
const RANK = Object.keys(HEARD);
const languageName = new Intl.DisplayNames(['en'], { type: 'language' });
const heard = [];

$('hear').addEventListener('click', () => busy($('hear-status'), async () => {
  if (!SR?.available) throw new Error('This Chrome cannot say: it has no on-device speech recognition API.');
  heard.length = 0;
  $('hear-results').replaceChildren();
  for (const [lang, locales] of Object.entries(LOCALES)) {
    say($('hear-status'), `Asking about ${languageName.of(lang)}…`);
    let best = { state: 'unavailable', locale: locales[0] };
    const problems = [];
    for (const locale of [...locales, lang]) {
      try {
        const state = await SR.available({ langs: [locale], processLocally: true });
        if (RANK.indexOf(state) !== -1 && RANK.indexOf(state) < RANK.indexOf(best.state)) best = { state, locale };
        if (RANK.indexOf(state) === -1) problems.push(`${locale}: unexpected answer "${state}"`);
      } catch (error) {
        problems.push(`${locale}: ${error?.message ?? error}`);
      }
    }
    heard.push({ lang, name: languageName.of(lang), ...best, problems });
  }
  heard.sort((a, b) => RANK.indexOf(a.state) - RANK.indexOf(b.state) || a.name.localeCompare(b.name));
  for (const row of heard) {
    const tr = document.createElement('tr');
    const detail = row.problems.length > 0 ? ` (${row.problems.join('; ')})` : '';
    for (const [i, text] of [row.name, HEARD[row.state] + detail, row.locale].entries()) {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 1 && row.state === 'unavailable') td.className = 'bad';
      tr.append(td);
    }
    $('hear-results').append(tr);
  }
  const count = (state) => heard.filter((row) => row.state === state).length;
  say($('hear-status'), `Of 31 languages, Chrome can hear ${count('available')} now, could download `
    + `${count('downloadable') + count('downloading')} more, and cannot hear ${count('unavailable')}.`);
}));

// ── Results ──────────────────────────────────────────────────────────────────────────────────

$('copy').addEventListener('click', () => busy($('run-status'), async () => {
  const lines = [
    `Supertonic 3 spike · revision ${REVISION.slice(0, 8)} · voice ${$('voice').value}`,
    loaded ? `Loaded on ${loaded.backend} in ${(loaded.ms / 1000).toFixed(1)} s · GPU: ${loaded.gpu}` : 'Not loaded',
    `Kokoro in the offscreen page: ${kokoro}`,
    'language\tbackend\tsteps\trun\tsynthesis s\taudio s\treal-time factor\tpeak',
    ...rows.map((r) => [r.lang, r.backend, r.steps, r.run, (r.ms / 1000).toFixed(2), r.audio.toFixed(2), r.rtf.toFixed(2), Number.isNaN(r.peak) ? 'NaN' : r.peak.toFixed(3)].join('\t')),
    ...(heard.length > 0
      ? ['', 'Chrome on-device recognition', 'language\tlocale\tanswer',
        ...heard.map((h) => [h.name, h.locale, h.state + (h.problems.length > 0 ? ` (${h.problems.join('; ')})` : '')].join('\t'))]
      : []),
  ];
  await navigator.clipboard.writeText(lines.join('\n'));
  say($('run-status'), `Copied ${rows.length} timing rows${heard.length > 0 ? ` and ${heard.length} languages` : ''}.`);
}));
