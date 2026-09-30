// Which colour an agent gets, and what letter stands for it.
//
// Ported from `BrowserTab.colourIndex(outOf:)` in `OpenPosseShared`, FNV-1a and all. The hash
// matters: Swift's `hashValue` is seeded per process, so the palette reshuffled on every
// launch until it was replaced with this. JavaScript has no such trap, but keeping the same
// function means an agent is the same colour in the extension as it was in the app – and a
// user who recorded Ivan as green does not find him blue after importing.

/** Red is deliberately absent: it means failure, never an agent. */
export const CHANNELS = ['#0A84FF', '#30D158', '#5E5CE6', '#64D2FF', '#FF375F'];

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // `Math.imul` for a real 32-bit multiply – `*` would go through a double and lose the
    // low bits that make this a hash at all.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function channelFor(name) {
  return CHANNELS[fnv1a(name.toLowerCase()) % CHANNELS.length];
}

/** The letter on the avatar. Capitalised, because it is shown large and alone. */
export function initialFor(name) {
  return (name.trim()[0] ?? '?').toUpperCase();
}
