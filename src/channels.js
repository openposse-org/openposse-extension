// Which colour an agent gets, and what letter stands for it.
//
// **Assigned, not hashed – since 2026-10-05.** The colour used to be a hash of the agent's name
// into five colours: FNV-1a, ported from `BrowserTab.colourIndex(outOf:)` so an agent kept the
// colour it had in the Mac app. Nothing stopped two names landing on the same one, and with five
// colours they usually did – Ivan and Priya were both green, and so were "Notion" and "LeanIX",
// the names a recording suggests for the two vendors this product was built against. A colour
// two agents share no longer says who is answering. Renaming an agent also changed its colour.
//
// So a colour is now chosen once, when the agent is made, as the free colour farthest from every
// colour already in use – and kept on the agent, where renaming and deleting cannot touch it.
// The hash survives only to say what colour an older agent was already showing, so that it keeps
// it.

/** The colour of failure. Never an agent's – see `last` below for the one that comes close. */
export const ERROR = '#FF453A';

/**
 * Sixteen colours, in hue order starting at blue. The Settings picker shows them in this order,
 * and ties are broken in it – so the first agent on an empty roster is blue.
 *
 * **The original five are kept exactly** – blue, green, indigo, sky and pink, the design's
 * channels – so nobody's agent changes colour. The other eleven were chosen on 2026-10-05 in
 * OKLCH, a colour space where equal steps look equally different, to fill the gaps around the
 * wheel: brightness alternates between neighbours, because sixteen hues at one brightness put
 * aqua 0.045 from turquoise and two colours that close cannot be told apart from memory. The
 * closest pair is now 0.075. All eleven are vivid enough to sit beside Apple's five, and none
 * is closer than 0.14 to the error red.
 *
 * **`last` marks pink, which is 0.05 from the error red** – near enough that a pink agent's
 * ring reads as "broken". It stays, because agents already showing it keep it and anybody may
 * choose it, but automatic assignment reaches it only once every other colour is taken.
 */
export const PALETTE = [
  { hex: '#0A84FF', name: 'Blue' },
  { hex: '#5E5CE6', name: 'Indigo' },
  { hex: '#A890FE', name: 'Violet' },
  { hex: '#F3ADFE', name: 'Lilac' },
  { hex: '#D65CBE', name: 'Magenta' },
  { hex: '#FF90B0', name: 'Rose' },
  { hex: '#FF375F', name: 'Pink', last: true },
  { hex: '#CD7D04', name: 'Orange' },
  { hex: '#FFBC64', name: 'Apricot' },
  { hex: '#C3BE01', name: 'Citron' },
  { hex: '#73A402', name: 'Lime' },
  { hex: '#30D158', name: 'Green' },
  { hex: '#03EDB0', name: 'Mint' },
  { hex: '#04BFA5', name: 'Jade' },
  { hex: '#07D0D6', name: 'Turquoise' },
  { hex: '#64D2FF', name: 'Sky' },
];

export const CHANNELS = PALETTE.map((c) => c.hex);

/** The five colours the hash used, in its order. Only for agents from before colours were kept. */
const LEGACY = ['#0A84FF', '#30D158', '#5E5CE6', '#64D2FF', '#FF375F'];

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

/** The colour an agent was shown in before colours were kept: the old hash of its name. */
function legacyChannel(name) {
  return LEGACY[fnv1a(String(name).toLowerCase()) % LEGACY.length];
}

/**
 * A colour as OKLab coordinates, where straight-line distance tracks how different two colours
 * look. RGB distance does not: it calls two greens far apart and a green and a teal close.
 */
function oklab(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** How different two `#RRGGBB` colours look. Around 0.02 is the smallest difference anyone sees. */
export function colourDistance(a, b) {
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const isChannel = (value) => CHANNELS.includes(value);

/**
 * The colour for a new agent, given the colours already in use.
 *
 * **The free colour farthest from every colour in use**, rather than the next one in a list. A
 * list hands the second agent whatever sits beside the first; this hands it the colour least like
 * anything on screen, and it keeps working after deletions and after somebody picks colours by
 * hand in Settings, because it looks at what is actually taken rather than at a counter.
 *
 * Beyond sixteen agents a colour has to be shared, and it is the least-used one.
 */
export function pickChannel(taken = []) {
  const used = taken.filter(isChannel);
  const free = PALETTE.filter((c) => !used.includes(c.hex));
  const pool = free.some((c) => !c.last) ? free.filter((c) => !c.last) : free;

  if (pool.length > 0) {
    let best = pool[0].hex;
    let farthest = -1;
    for (const { hex } of pool) {
      const nearest = used.length ? Math.min(...used.map((u) => colourDistance(hex, u))) : Infinity;
      if (nearest > farthest) { farthest = nearest; best = hex; }
    }
    return best;
  }

  const uses = (hex) => used.filter((u) => u === hex).length;
  return CHANNELS.reduce((best, hex) => (uses(hex) < uses(best) ? hex : best), CHANNELS[0]);
}

/**
 * Every agent with a colour, giving one to any agent that has never had one.
 *
 * **Pure, and the same answer every time for the same roster**, so every context that reads the
 * roster draws the same colours without any of them having to write first. `loadRoster` runs
 * this, and every roster write goes through `loadRoster` – so the first write after this ships
 * stores the colours, and from then on they are kept rather than worked out.
 *
 * A kept colour is never moved. An older agent keeps the colour it was already showing, unless
 * an agent earlier in the roster holds it – the one that has had it longest – in which case it
 * gets a new one by the same rule as a new agent.
 */
export function assignChannels(agents) {
  const taken = agents.map((a) => a.channel).filter(isChannel);
  return agents.map((agent) => {
    if (isChannel(agent.channel)) return agent;
    const before = legacyChannel(agent.name ?? '');
    const channel = taken.includes(before) ? pickChannel(taken) : before;
    taken.push(channel);
    return { ...agent, channel };
  });
}

/**
 * An agent's colour. Every agent from `loadRoster` has one; the fallback is for anything that was
 * built some other way, so nothing is ever drawn without a colour.
 */
export function channelOf(agent) {
  return isChannel(agent?.channel) ? agent.channel : legacyChannel(agent?.name ?? '');
}

/** The name a person reads for a colour, in the Settings picker. */
export function colourName(hex) {
  return PALETTE.find((c) => c.hex === hex)?.name ?? hex;
}

/** The letter on the avatar. Capitalised, because it is shown large and alone. */
export function initialFor(name) {
  return (name.trim()[0] ?? '?').toUpperCase();
}
