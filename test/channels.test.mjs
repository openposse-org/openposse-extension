// Agent colours: the palette, the rule that hands them out, and what happens to agents that had
// a colour before colours were kept.
//
// The palette tests are about a *future edit*: sixteen colours chosen to stay apart, and a
// seventeenth or a tweak that lands near a neighbour, or near the error red, fails here rather
// than as two agents nobody can tell apart.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE, CHANNELS, ERROR, pickChannel, assignChannels, channelOf, colourDistance,
} from '../src/channels.js';

const hex = (name) => PALETTE.find((c) => c.name === name).hex;

/** WCAG contrast against the panel's own background. */
function contrastOnPanel(colour) {
  const lum = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return (lum(colour) + 0.05) / (lum('#0B0A0C') + 0.05);
}

test('sixteen colours, all different, and the original five unchanged', () => {
  assert.equal(PALETTE.length, 16);
  assert.equal(new Set(CHANNELS).size, 16);
  for (const colour of CHANNELS) assert.match(colour, /^#[0-9A-F]{6}$/, `${colour} is not #RRGGBB`);
  // Agents already showing these keep them, so none of the five may move.
  for (const kept of ['#0A84FF', '#30D158', '#5E5CE6', '#64D2FF', '#FF375F']) {
    assert.ok(CHANNELS.includes(kept), `${kept} left the palette`);
  }
});

test('no two colours are close enough to be mistaken for each other', () => {
  for (let i = 0; i < CHANNELS.length; i += 1) {
    for (let j = i + 1; j < CHANNELS.length; j += 1) {
      const d = colourDistance(CHANNELS[i], CHANNELS[j]);
      assert.ok(d >= 0.07, `${PALETTE[i].name} and ${PALETTE[j].name} are ${d.toFixed(3)} apart`);
    }
  }
});

test('nothing but pink comes near the error red, and pink is handed out last', () => {
  for (const { hex: colour, name, last } of PALETTE) {
    if (last) continue;
    assert.ok(colourDistance(colour, ERROR) >= 0.14, `${name} is too close to the error red`);
  }
  assert.deepEqual(PALETTE.filter((c) => c.last).map((c) => c.name), ['Pink']);
});

test('every colour can be read on the panel', () => {
  // 3:1 is the bar for a control's colour. Indigo, one of the original five, is the lowest at
  // 3.9; the eleven added are all above 4.5, the bar for text.
  for (const { hex: colour, name } of PALETTE) {
    assert.ok(contrastOnPanel(colour) >= 3, `${name} is ${contrastOnPanel(colour).toFixed(2)}:1`);
  }
});

test('the first agent is blue, and each next one gets the colour least like the rest', () => {
  assert.equal(pickChannel([]), hex('Blue'));
  // Whatever it picks, it is never a colour already in use while a free one exists, and it is
  // never nearer to anything taken than the free colour it passed over.
  const taken = [hex('Blue'), hex('Green')];
  const picked = pickChannel(taken);
  assert.ok(!taken.includes(picked));
  const nearest = (colour) => Math.min(...taken.map((t) => colourDistance(colour, t)));
  for (const colour of CHANNELS.filter((c) => !taken.includes(c) && c !== hex('Pink'))) {
    assert.ok(nearest(picked) >= nearest(colour), `${picked} was picked over the more distant ${colour}`);
  }
});

test('sixteen agents get sixteen colours, and pink only when nothing else is free', () => {
  const taken = [];
  for (let i = 0; i < 16; i += 1) {
    const colour = pickChannel(taken);
    if (i < 15) assert.notEqual(colour, hex('Pink'), `pink handed out as agent ${i + 1}`);
    taken.push(colour);
  }
  assert.equal(new Set(taken).size, 16);
  assert.equal(taken[15], hex('Pink'));
  // The seventeenth has to share, and shares the least-used colour.
  const twice = [...CHANNELS, ...CHANNELS.filter((c) => c !== hex('Lime'))];
  assert.equal(pickChannel(twice), hex('Lime'));
});

test('agents from before colours were kept keep theirs, unless someone older has it', () => {
  // The real clash that started this: Ivan and Priya both hashed to green.
  const [ivan, andy, priya] = assignChannels([
    { id: 'i', name: 'Ivan' }, { id: 'a', name: 'Andy' }, { id: 'p', name: 'Priya' },
  ]);
  assert.equal(ivan.channel, hex('Green'), 'Ivan has had green longest, so he keeps it');
  assert.equal(andy.channel, hex('Sky'));
  assert.notEqual(priya.channel, hex('Green'), 'Priya moves off the colour Ivan holds');
  assert.notEqual(priya.channel, andy.channel);
});

test('a kept colour is never moved, and a bad one is replaced', () => {
  const [ivan, priya] = assignChannels([
    { id: 'i', name: 'Ivan' },
    // Priya holds green explicitly, so Ivan – whose old hash also says green – must move.
    { id: 'p', name: 'Priya', channel: hex('Green') },
  ]);
  assert.equal(priya.channel, hex('Green'));
  assert.notEqual(ivan.channel, hex('Green'));

  const [odd] = assignChannels([{ id: 'o', name: 'Odd', channel: '#123456' }]);
  assert.ok(CHANNELS.includes(odd.channel), 'a colour outside the palette is not kept');
});

test('the same roster always gets the same colours', () => {
  // Every context resolves colours on its own, so they only agree if this is deterministic.
  const roster = ['Ivan', 'Andy', 'Priya', 'Notion', 'LeanIX'].map((name) => ({ id: name, name }));
  assert.deepEqual(assignChannels(roster), assignChannels(roster));
  assert.equal(new Set(assignChannels(roster).map((a) => a.channel)).size, roster.length);
});

test('an agent built some other way still gets a colour', () => {
  assert.ok(CHANNELS.includes(channelOf({ name: 'Ivan' })));
  assert.equal(channelOf({ name: 'Ivan', channel: hex('Lime') }), hex('Lime'));
});
