// Playing synthesised speech: shared by every engine whose audio is ours before it is heard.
//
// Moved out of `kokoro.js` unchanged, so a second engine speaks through the same scheduling, the
// same level meter for the orb and the same silence check. Two copies of this would drift, and
// each part of it was paid for once already (see the comments below).
//
// The engine owns what is engine-specific: when a chunk exists, whether the voice is held before
// there is a player to hold, and what a cancel means. This owns the speakers.

/**
 * The loudest sample in the synthesised audio, 0–1.
 *
 * Every channel of every chunk, rather than a sample of the first one: a model that fails
 * partway through produces a buffer that starts fine and ends silent, and peeking at the front
 * would call that healthy. A few hundred thousand comparisons costs well under a millisecond
 * against synthesis measured in hundreds.
 */
export function peak(buffers) {
  let max = 0;
  for (const buffer of buffers) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.abs(samples[i]);
        if (value > max) max = value;
      }
    }
  }
  return Math.round(max * 1000) / 1000;
}

/**
 * Below this peak a chunk is treated as silence rather than as quiet speech.
 *
 * NaN reaches the WAV encoder as zeros, so a model that computed garbage produces a buffer of the
 * right duration with nothing in it. See `peak` and the dtype notes in `weights.js`.
 */
export const SILENT_PEAK = 1e-4;

/** ~20 Hz, matching the microphone meter. The orb runs at 60 and eases between readings. */
const LEVEL_MS = 50;

/**
 * A player that accepts buffers while it is already speaking, reporting the **real output
 * level** as it goes.
 *
 * The level is what the design asks for and `speechSynthesis` cannot give: "the TTS output
 * level while an agent speaks". The system-voice path has to make do with `boundary` events –
 * speech *rate*, not loudness – because it renders straight to the device and exposes no audio
 * node. Here the audio is ours before it is heard, so an `AnalyserNode` on the way to the
 * speakers gives the orb the same signal the microphone gives it. An orb that moves with the
 * voice is an instrument; one that moves on a timer is an animation.
 *
 * **Chunks are scheduled on the audio clock, not chained on `onended`.** Chaining was correct
 * while every buffer existed before playback began, and is wrong now that they arrive during
 * it: starting each one when the previous *ends* adds a main-thread callback's worth of gap
 * between sentences, and the gaps are audible. `start(when)` against `ctx.currentTime` hands
 * the sequencing to the audio clock and the joins are sample-accurate.
 *
 * `Math.max(ctx.currentTime, nextAt)` is the whole fallback for synthesis losing the race: if
 * the speakers have already drained, the next sentence starts immediately instead of being
 * scheduled in the past. There is a gap either way; this is where it goes, and it is the honest
 * place for it.
 *
 * @param onLevel  called with an amplitude, 0–1, about twenty times a second
 * @param held     start paused – a pause can arrive before there is any player to hold, and the
 *                 player made after it has to start held, not speak the first sentence and stop
 * @param onEnd    called once with the player when it finishes or is stopped, so the engine can
 *                 forget it
 */
export function play(onLevel, { held: startHeld = false, onEnd = () => {} } = {}) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(ctx.destination);
  const samples = new Float32Array(analyser.fftSize);

  // A suspended context keeps its last frame in the analyser, so a held voice would go on
  // reporting the syllable it stopped on, and the orb would keep moving to a voice that is silent.
  let held = false;
  const meter = setInterval(() => {
    if (held) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    // Same decibel mapping as the microphone, so the orb behaves identically whether it is
    // following you or following an agent – which is the point of it being one orb.
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    onLevel(Math.min(1, Math.max(0, (db + 55) / 45)));
  }, LEVEL_MS);

  const sources = [];
  let nextAt = 0;
  let outstanding = 0;
  let noMoreComing = false;
  let settle = null;
  let stopped = false;

  const done = new Promise((resolve) => { settle = resolve; });

  const teardown = (result) => {
    if (stopped) return;
    stopped = true;
    clearInterval(meter);
    onLevel(0);
    onEnd(player);
    ctx.close().catch(() => {});
    settle(result);
  };

  // Resolving needs *both* conditions: nothing still playing, and nothing more to come. Either
  // one alone is wrong – the speakers drain between sentences while synthesis continues, and
  // the last chunk arrives well before it has been spoken.
  const maybeDone = () => {
    if (noMoreComing && outstanding === 0) teardown({ ok: true });
  };

  const player = {
    push(buffer) {
      if (stopped) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      const at = Math.max(ctx.currentTime, nextAt);
      nextAt = at + buffer.duration;
      outstanding += 1;
      source.onended = () => { outstanding -= 1; maybeDone(); };
      sources.push(source);
      source.start(at);
    },

    /** No more chunks are coming. Resolves once what is already scheduled has been heard. */
    finish() {
      noMoreComing = true;
      maybeDone();
      return done;
    },

    /** Gives up without speaking what is queued – a silent model, or an interruption. */
    stop() {
      for (const source of sources) {
        try { source.stop(); } catch { /* already finished, or never started */ }
      }
      teardown({ ok: false, reason: 'cancelled' });
    },

    /**
     * Holds the voice mid-word by suspending the audio clock. Everything scheduled is scheduled
     * against that clock, so the queue stays in step and synthesis can carry on filling it.
     */
    pause() {
      if (held || stopped) return;
      held = true;
      onLevel(0);
      ctx.suspend().catch((error) => {
        console.warn('[openposse] the voice could not be paused –', error?.message ?? error);
      });
    },

    resume() {
      if (!held || stopped) return;
      held = false;
      ctx.resume().catch((error) => {
        console.warn('[openposse] the voice could not be resumed –', error?.message ?? error);
      });
    },
  };

  if (startHeld) player.pause();
  return player;
}
