import * as utils from "./utils.mjs";

// ── OpenPosse patch ────────────────────────────────────────────────────────────────────────
//
// The only change to vendored HeadTTS, and it is two lines. Everything below is upstream.
//
// It replaces `fetch` inside this worker so the model and the voices come from the cache
// `weights.js` filled and hash-checked, and so there is **no route to the network from here at
// all**. Installed before anything else runs, because the dynamic `import()` of transformers.js
// below is itself a fetch.
//
// See `openposse-local-only.mjs` for why this is a shim rather than configuration.
import { installLocalOnlyFetch, reportWorkerFailures } from "./openposse-local-only.mjs";
installLocalOnlyFetch();
reportWorkerFailures();
// ── end patch ──────────────────────────────────────────────────────────────────────────────

// Dynamic imports
let StyleTextToSpeech2Model;
let AutoTokenizer;
let Tensor;
let env;
let LogLevel;

// Status flags
let filesProgress;
let isReady = false;
let isProcessing = false;
let isTraceConnection = false;
let isTraceG2P = false;
let isTraceLanguage = false;

// Other globals
let model = null; // Model
let tokenizer = null; // Tokenizer
const languages = new Map(); // Language modules
const voices = new Map(); // Voices
let settings = {}; // Settings
const queue = []; // Text-to-speech work queue

// Different event handler for Node.js and browsers
let eventHandler;
let fileReader;
const isNode = typeof import.meta !== 'undefined' &&
         typeof import.meta.url === 'string' &&
         import.meta.url.startsWith('file://');
if (isNode) {
  const { readFile } = await import ('node:fs/promises');
  fileReader = readFile;
  const { parentPort } = await import('node:worker_threads');
  eventHandler = parentPort;
} else {
  eventHandler = self;
}

/**
* Event handler.
*
* @param {MessageEvent} ev Message event
*/
eventHandler.onmessage = async (ev) => {
  const message = ev.data;
  if ( message.type === 'synthesize' ) {
    queue.push(message);
    process();
  } else if ( message.type === 'setup' ) {
    const o = message.data;
    if ( typeof o === 'object' && !Array.isArray(o) && o !== null ) {
      Object.assign(settings, o);
    }
  } else if ( message.type === 'connect' ) {
    const o = message.data;
    if ( typeof o === 'object' && !Array.isArray(o) && o !== null ) {
      Object.assign(settings, o);
      isTraceConnection = settings.trace & utils.traceMask.connection;
      isTraceG2P = settings.trace & utils.traceMask.g2p;
      isTraceLanguage = settings.trace & utils.traceMask.language;
    }
    connect();
  } else {
    console.error('HeadTTS Worker: Unknown message type "' + message.type + '".');
  }
}

/**
* Calculate and report progress
*
* @param {ProgressEvent} ev Progress event
*/
function progress(ev) {

  // Update data
  if ( ev.status === 'progress' ) {
    if ( !filesProgress.hasOwnProperty(ev.file) ) {
      filesProgress[ev.file] = { loaded: 0, total: 0 };
    }
    filesProgress[ev.file].loaded = ev.loaded;
    filesProgress[ev.file].total = ev.total;

    // Calculate progress
    let loaded = 0;
    let total = 0;
    for( let key in filesProgress ) {
      loaded += filesProgress[key].loaded;
      total += filesProgress[key].total;
    }

    // Update progress
    eventHandler.postMessage({
      type: "progress",
      data: {
        loaded: loaded,
        total: total,
        lengthComputable: ( total && (total > 0) && (total >= loaded) )
      }
    });

  }

}

/**
* Set up the model and pre-load voices.
*/
async function connect() {

  if ( isTraceConnection ) {
    utils.trace( 'Loading model "' + settings.transformersModule + '" started.' );
  }

  // Load modules dynamically
  try {
    ({ StyleTextToSpeech2Model, AutoTokenizer, Tensor, env, LogLevel } = await import(settings.transformersModule));
    
    // Set log level to ERROR
    env.logLevel = LogLevel.ERROR;

    // ── OpenPosse patch ──────────────────────────────────────────────────────────────────
    // Tell ONNX Runtime where its WASM lives, or it fetches from a CDN — which the shim
    // above refuses, correctly, and which would be remotely hosted code besides. Resolved
    // from this module's own URL rather than through `chrome.runtime`, which is not reliably
    // present in a dedicated worker.
    //
    // **This one matters more than it looks.** ONNX Runtime spawns its own worker and uses a
    // synchronous XMLHttpRequest in its Emscripten glue, and neither goes through the fetch
    // shim — so this path is the *only* thing keeping the WASM load local.
    env.backends.onnx.wasm.wasmPaths = new URL("../transformers/", import.meta.url).href;

    // **No remote URL is constructed in the first place.** The shim refuses them, but refusing
    // is the second line: with this, `from_pretrained` builds
    // `<localModelPath>/<model id>/onnx/...` — a chrome-extension:// URL — and never assembles
    // a huggingface.co one at all. The shim then serves it from the verified cache.
    //
    // Belt and braces on purpose, because the shim turned out not to cover everything: it
    // replaces `fetch` in *this* worker, and ONNX Runtime's own worker has its own.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = new URL("../models/", import.meta.url).href;
    // ── end patch ────────────────────────────────────────────────────────────────────────

  } catch(error) {
    console.error("HeadTTS Worker: Importing modules failed, error=", error);
    throw new Error("Importing modules failed.");
  }

  if ( isTraceConnection ) {
    utils.trace( 'Loading model "' + settings.transformersModule + '" ended.' );
  }

  try {

    // Clear progress data
    filesProgress = {};

    let voices = settings.voices || [];
    const results = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained( settings.model, {
        dtype: settings.dtype,
        device: settings.device,
        progress_callback: progress
      }),
      AutoTokenizer.from_pretrained( settings.model, {
        progress_callback: progress
      }),
      ...settings.voices.map( async (x) => {
        try {
          loadVoice(x);
        } catch(error) {
          // Ignore errors on pre-load
        }
      }),
      ...settings.languages.map( async (x) => {
        try {
          loadLanguage(x);
        } catch(error) {
          // Ignore errors on pre-load
        }
      })
    ]);
    model = results[0];
    tokenizer = results[1];

    // ── OpenPosse patch ──────────────────────────────────────────────────────────────────
    // **Answers "is it actually on the GPU" from the session itself**, rather than from the
    // fact that we asked for it. Synthesis measured 1.6x real time — between WebGPU's ~0.3x
    // and WASM's ~3x — and the reason that was hard to diagnose is that `device: "webgpu"`
    // was set and believed, while part of the graph could still be running on the CPU for
    // want of int8 kernels.
    //
    // `executionProviders` is what ONNX Runtime actually bound, which is the only statement
    // here that is not an intention.
    // The first attempt guessed at two field names, found neither, and reported "unknown" —
    // which says only that the guess was wrong. So when no known shape matches, this reports
    // the **key names it actually found**, and the next run says where the answer lives instead
    // of whether a third guess was lucky.
    try {
      const sessions = Object.values(model?.sessions ?? {});
      const found = [];
      let shape = null;
      for ( const s of sessions ) {
        const handler = s?.handler ?? s?._handler ?? null;
        const candidate = handler?._executionProviders ?? handler?.executionProviders
          ?? s?._executionProviders ?? s?.executionProviders ?? null;
        if ( candidate ) {
          found.push(...(Array.isArray(candidate) ? candidate : [candidate]));
        } else if ( !shape ) {
          // Not a fallback value — a description of where to look next time.
          shape = {
            session: Object.keys(s ?? {}).slice(0, 24),
            handler: handler ? Object.keys(handler).slice(0, 24) : null,
            handlerName: handler?.constructor?.name ?? null,
          };
        }
      }
      eventHandler.postMessage({
        type: "openposse-backend",
        requested: settings.device,
        dtype: settings.dtype,
        providers: found.map((p) => (typeof p === "string" ? p : (p?.name ?? String(p))))
          .filter(Boolean),
        sessions: sessions.length,
        shape,
      });
    } catch(error) {
      // Diagnostics must never break loading — but a diagnostic that fails silently is the
      // exact fault it was added to cure.
      console.error("OpenPosse: backend report failed, error=", error);
      eventHandler.postMessage({
        type: "openposse-backend",
        requested: settings.device,
        dtype: settings.dtype,
        providers: [],
        error: String(error?.message ?? error),
      });
    }
    // ── end patch ────────────────────────────────────────────────────────────────────────
  } catch(error) {
    console.error("HeadTTS Worker: Loading models failed, error=", error, " settings=", settings);
    throw new Error("Loading models failed.");
  }

  // Ready
  isReady = true;
  eventHandler.postMessage({ type: "ready" });

  // Process
  process();
}

/**
* Load a specific language module.
*
* @param {string} lang Language, e.g. "en-us"
* @return {Object} Language module instance.
*/
async function loadLanguage(lang) {
  if ( languages.has(lang) ) {
    return languages.get(lang);
  } else {
    if ( isTraceConnection ) {
      utils.trace( 'Importing language "' + lang + '".' );
    }
    let Language;
    ({ Language } = await import("./language-" + lang.toLowerCase() + ".mjs"));
    const language = new Language({
      trace: isTraceLanguage
    });
    if ( isNode && settings.dictionaryPath ) {
      if ( !settings.dictionaryPath.endsWith("/") ) {
        settings.dictionaryPath += "/";
      }
      await language.loadDictionary( settings.dictionaryPath + lang.toLowerCase() + ".txt");
    } else if ( !isNode && settings.dictionaryURL ) {
      if ( !settings.dictionaryURL.endsWith("/") ) {
        settings.dictionaryURL += "/";
      }
      await language.loadDictionary( settings.dictionaryURL + lang.toLowerCase() + ".txt");
    }
    languages.set( lang, language );
    return language;
  }
}

/**
* Load a specific voice.
*
* @param {string} s Voice name.
* @return {ArrayBuffer} Voice data.
*/
async function loadVoice(s) {
  if ( voices.has(s) ) {
    return voices.get(s);
  } else {
    let voice;
    [ voice ] = await Promise.all([
      (async () => {
        let url, path, response, buffer;
        if ( isNode && settings.voicePath ) {
          path = settings.voicePath + (settings.voicePath.endsWith("/") ? "" : "/") + s + ".bin";
          if ( isTraceConnection ) {
            utils.trace( 'Loading voice "' + path + '".' );
          }
          response = await fileReader(path);
          buffer =  response.buffer.slice(response.byteOffset, response.byteOffset + response.byteLength);
          return buffer;
        } else if ( !isNode && settings.voiceURL ) {
          const url = new URL(settings.voiceURL, self.location.href);
          url.pathname += (url.pathname.endsWith("/") ? "" : "/") + s + ".bin";
          if ( isTraceConnection ) {
            utils.trace( 'Loading voice "' + url + '".' );
          }
          response = await fetch(url);
          if ( response.ok ) {
            buffer = await response.arrayBuffer();
            return buffer;
          }
        }
        throw new Error('HeadTTS Worker: Error loading voice "' + s + '".');
      })()
    ]);
    voices.set( s, voice );
    return voice;
  }
}


/**
* Calculate starting times and durations for TalkingHead words and visemes.
*
* @param {Object} o TalkingHead audio object to be updated
* @param {number[]} ds Token durations in frames
* @param {number[][]} silences Sorted array of [index,duration] of silences.
*/
function updateTimestamps(o,ds,silences) {

  // Calculate starting times in milliseconds
  const scaler = 1000 / settings.frameRate; // From frames to milliseconds
  const times = [];
  let t = 0;
  let len = ds.length;
  for( let i=0; i<len; i++ ) {
    times.push( Math.round(t) );
    t += scaler * ds[i];
  }
  times.push( Math.round(t) ); // Last entry

  // Shift times based on silent periods and
  // convert phoneme indexes to original starting times
  const shifts = silences.map( x => [x[0]+1,x[1]] );
  silences.forEach( x => x[0] = times[x[0]] - 20 );
  shifts.forEach( x => {
    for( let i=x[0]; i<times.length; i++ ) {
      times[i] += x[1];
    }
  });

  // Calculate word times and durations (+1 because of $)
  len = o.words.length;
  for( let i=0; i<len; i++ ) {
    const start = times[o.wtimes[i]+1] + settings.deltaStart;
    const end = times[o.wdurations[i]+1] + settings.deltaEnd;
    const duration = end - start;
    o.wtimes[i] = start;
    o.wdurations[i] = duration;
  }

  // Calculate visemes times and durations (+1 because of $)
  len = o.visemes.length;
  for( let i=0; i<len; i++ ) {
    const start = times[o.vtimes[i]+1] + settings.deltaStart;
    const end = times[o.vdurations[i]+1] + settings.deltaEnd;
    const duration = end - start;
    o.vtimes[i] = start;
    o.vdurations[i] = duration;
  }

}


/**
* Process the work queue: phonemize the text, tokenize phonemes, load voice,
* run inference, encode audio, and post the response message.
*/
async function process() {
  if ( isProcessing || !isReady ) return;
  isProcessing = true;
  while( queue.length ) {
    const item = queue[0];
    queue.shift();
    const d = item.data;

    // Generate tokens/phonemes and initialize TalkingHead audio object
    let language;
    try {
      language = await loadLanguage(d.language);
    } catch(error) {
      console.error("HeadTTS Worker: Error loading language module, error=", error, " item=", item);
      item.ref = item.id;
      delete item.id;
      item.type = "error";
      item.data = { error: "Error loading language module '" + d.language + "'." };
      eventHandler.postMessage(item);
      continue;
    }
    const { phonemes, metadata, silences } = language.generate(d.input);
    if ( isTraceG2P ) {
      if ( typeof d.input === "string" ) {
        utils.trace( "G2P: " + d.input );
      } else if ( Array.isArray(d.input) ) {
        d.input.forEach( x => {
          if ( typeof x === "string" ) {
            utils.trace( "G2P: " + x );
          } else {
            utils.trace( "G2P: { type=" + x.type + ", value=" + x.value + " }" );
          }
        });
      }
      utils.trace( "G2P: => " + phonemes.join("") + ", metadata=", metadata );
    }

    // Generate input IDs and run the model
    const { input_ids } = tokenizer(phonemes.join(""), {
      truncation: true
    });
    const num_tokens = Math.min(Math.max(input_ids.size - 2, 0), 509);
    let voice;
    try {
      voice = await loadVoice(d.voice);
    } catch(error) {
      console.error("HeadTTS Worker: Error loading voice, error=", error, " item=", item);
      item.ref = item.id;
      delete item.id;
      item.type = "error";
      item.data = { error: "Error loading voice '" + d.voice + "'." };
      eventHandler.postMessage(item);
      continue;
    }
    const data = new Float32Array(voice);
    const offset = num_tokens * settings.styleDim;
    const voiceData = data.slice(offset, offset + settings.styleDim);
    const inputs = {
      input_ids,
      style: new Tensor("float32", voiceData, [1, settings.styleDim]),
      speed: new Tensor("float32", [d.speed], [1]),
    };
    const { waveform, durations } = await model(inputs);

    // Generate timestamps from durations
    const durationsFrames = Array.from(durations.data);
    updateTimestamps( metadata, durationsFrames, silences );

    // Encode audio
    const samplerate = settings.audioSampleRate;
    let samples = waveform.data;
    if ( silences.length ) {
      samples = utils.insertSilences(samples, samplerate, silences)
    }
    if ( d.audioEncoding === "pcm" ) {
      metadata.audio = utils.encodeAudio(samples, samplerate, false);
      metadata.audioEncoding = "pcm";
    } else {
      metadata.audio = utils.encodeAudio(samples, samplerate, true);
      metadata.audioEncoding = "wav";
    }

    // Sent the TalkingHead object to the original caller
    item.ref = item.id;
    delete item.id;
    item.type = "audio";
    item.data = metadata;
    eventHandler.postMessage(item, [metadata.audio]);

  }
  isProcessing = false;

}
