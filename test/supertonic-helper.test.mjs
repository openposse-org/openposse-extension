// The vendored Supertonic helper's tail margin.
//
// Upstream sizes each utterance to exactly the duration predictor's estimate, which ends inside
// the last sound, so every answer lost its final phoneme. These run the helper's own `_infer`
// with stand-in graphs that only report sizes: they prove the margin reaches the latent mask and
// the audio, not that it is long enough. That needs the real model and an ear (the PR says what
// to listen for).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TextToSpeech, TAIL_MARGIN_S } from '../src/supertonic/helper.js';

// Illustrative sizes, not the shipped tts.json: one latent frame is 512 * 6 samples.
const CFGS = { ae: { sample_rate: 44_100, base_chunk_size: 512 }, ttl: { chunk_compress_factor: 6, latent_dim: 2 } };
const FRAME = 512 * 6;

/** A helper whose graphs predict `seconds` and otherwise pass sizes through. */
function helper(seconds, seen) {
  const textProcessor = { call: () => ({ textIds: [[1, 2, 3]], textMask: [[[1, 1, 1]]] }) };
  const dp = { run: async () => ({ duration: { data: Float32Array.of(seconds) } }) };
  const textEnc = { run: async () => ({ text_emb: {} }) };
  const vectorEst = {
    run: async ({ noisy_latent: xt, latent_mask: mask }) => {
      seen.mask = Array.from(mask.data);
      return { denoised_latent: { data: xt.data } };
    },
  };
  // The vocoder turns each latent frame into FRAME samples.
  const vocoder = { run: async ({ latent }) => ({ wav_tts: { data: new Float32Array(latent.dims[2] * FRAME) } }) };
  return new TextToSpeech(CFGS, textProcessor, dp, textEnc, vectorEst, vocoder);
}

const STYLE = { dp: {}, ttl: { dims: [1] } };

test('the margin is a small fixed pause, not a rescale', () => {
  assert.ok(TAIL_MARGIN_S >= 0.1 && TAIL_MARGIN_S <= 0.3, String(TAIL_MARGIN_S));
});

test('each utterance runs past the predicted end by the margin', async () => {
  for (const [predicted, speed] of [[1.0, 1.05], [0.37, 1.26], [2.5, 0.8]]) {
    const seen = {};
    const { wav, duration } = await helper(predicted, seen)._infer(['x'], ['en'], STYLE, 1, speed);
    const end = predicted / speed;
    const label = `${predicted} s at ${speed}`;

    assert.ok(Math.abs(duration[0] - (end + TAIL_MARGIN_S)) < 1e-6, label);
    // The latent mask is what lets the model generate there, so the margin must reach it.
    const unmasked = seen.mask.filter((v) => v === 1).length * FRAME;
    assert.ok(unmasked >= Math.floor((end + TAIL_MARGIN_S) * CFGS.ae.sample_rate), label);
    assert.ok(wav.length - Math.floor(end * CFGS.ae.sample_rate) >= TAIL_MARGIN_S * CFGS.ae.sample_rate, label);
  }
});
