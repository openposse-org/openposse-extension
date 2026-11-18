// The Recording bar: a small pill in the corner of the page being lassoed.
//
// The panel already shows the recording's card, but the panel can be shut, or the person can be
// looking at the page and not at it. A recording is OpenPosse watching their clicks on a site, so
// the page itself should say so for as long as it lasts, and offer a way to stop.
//
// **Drawn in a closed shadow root**, so the vendor's page cannot style it and its own scripts
// cannot reach into it. The recorder ignores it by tag (`BAR_TAG`): a press on it is never a
// control of the assistant, and it is never an answer.
//
// Only in the top frame. The content script runs in every frame of the tab, and one bar per
// iframe would be a stack of them.

import { BAR_TAG } from './recorder.js';
import { tell } from './tell.js';

let host = null;
let keeper = null;

export function showBar() {
  if (window.top !== window || host) return;
  host = document.createElement(BAR_TAG);
  // `all: initial` so nothing the page sets on custom elements or `*` reaches it.
  host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .bar { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px;
      font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
      background: rgba(20, 22, 28, 0.9); border-radius: 999px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #ff3b30;
      animation: pulse 1.4s infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    button { font: inherit; color: #fff; background: rgba(255, 255, 255, 0.16); border: 0;
      border-radius: 999px; padding: 5px 10px; cursor: pointer; }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, 0.28); }
  </style>
  <div class="bar" role="status" aria-label="OpenPosse is lassoing this tab">
    <span class="dot" aria-hidden="true"></span>
    <span>OpenPosse is lassoing this tab</span>
    <button type="button">Stop</button>
  </div>`;
  root.querySelector('button').addEventListener('click', (event) => {
    event.stopPropagation();
    // The same as Stop on the panel's card: the recording ends and nothing is saved. The
    // worker checks it came from the tab being lassoed.
    tell({ kind: 'openposse.record.stopFromPage' });
  });
  document.documentElement.append(host);
  // A single-page app can replace the whole document body, or clear `<html>` of strangers.
  // Put it back rather than let the recording carry on unannounced.
  keeper = setInterval(() => {
    if (host && !host.isConnected) document.documentElement.append(host);
  }, 1000);
}

export function hideBar() {
  clearInterval(keeper);
  keeper = null;
  host?.remove();
  host = null;
}
