// Builds the extension into `dist/`: a complete, loadable extension, and the only thing that
// ships.
//
// Source and output are separate folders so that what Chrome loads, and what goes into a store
// zip, is exactly what this script put there. `src/` holds the code, the pages and the manifest;
// `public/` holds files copied as they are (icons, the vendored speech libraries, the
// pronunciation dictionaries). Nothing else – not `tools/`, not `test/`, not `node_modules/` –
// can end up in the package, which it could while the folder Chrome loaded was the repo itself.
//
//   node tools/build.mjs            a development build. It keeps the manifest's `key`, so the
//                                   unpacked extension keeps its ID, and with it its storage:
//                                   the roster, the recipes and the downloaded voice.
//   node tools/build.mjs --watch    the same, rebuilt on every change.
//   node tools/build.mjs --store    what goes to the Chrome Web Store: no `key`, which the store
//                                   refuses outright, and none of the developer-only files.

import * as esbuild from 'esbuild';
import { watch } from 'node:fs';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const OUT = 'dist';
const store = process.argv.includes('--store');
const watching = process.argv.includes('--watch');

/** Module pages and the service worker. */
const MODULES = {
  'service-worker': 'src/service-worker.js',
  setup: 'src/setup.js',
  popup: 'src/popup.js',
  sidepanel: 'src/sidepanel.js',
  offscreen: 'src/offscreen.js',
  spike: 'src/spike.js',
};

/**
 * Classic scripts. `content` and `orb` are injected into vendors' pages, where a module cannot
 * go; `theme-boot` runs before a page paints; `capture` is pasted into DevTools by hand.
 */
const SCRIPTS = {
  content: 'src/content.js',
  orb: 'src/orb.js',
  'theme-boot': 'src/theme-boot.js',
  capture: 'tools/capture.js',
};

/** For developing OpenPosse rather than using it. Left out of a store build. */
const DEV_ONLY = new Set(['spike', 'spike.html', 'capture']);

const shipped = (entries) =>
  Object.fromEntries(Object.entries(entries).filter(([name]) => !(store && DEV_ONLY.has(name))));

/** The pages, the stylesheet, `public/` and the manifest – everything esbuild does not write. */
async function copyStatic() {
  // Finder litters folders with `.DS_Store`; none of it belongs in a package.
  await cp('public', OUT, { recursive: true, filter: (path) => !path.endsWith('.DS_Store') });

  for (const file of await readdir('src')) {
    if (/\.(html|css)$/.test(file) && !(store && DEV_ONLY.has(file))) {
      await cp(`src/${file}`, `${OUT}/${file}`);
    }
  }

  const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  // Two version numbers that can disagree eventually will. The manifest's is the one Chrome and
  // the store read; release tooling bumps both, and this stops a hand edit getting past one.
  if (manifest.version !== version) {
    throw new Error(`manifest.json says ${manifest.version} but package.json says ${version}`);
  }
  if (store) delete manifest.key;
  await writeFile(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

const options = [
  { entryPoints: shipped(MODULES), format: 'esm' },
  { entryPoints: shipped(SCRIPTS), format: 'iife' },
].map((entry) => ({
  ...entry,
  bundle: true,
  outdir: OUT,
  logLevel: 'warning',
  // Settings' debug drawer is shown in development builds only. See `setup.js`.
  define: { DEV_TOOLS: String(!store) },
}));

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await copyStatic();

  if (!watching) {
    await Promise.all(options.map((option) => esbuild.build(option)));
    console.log(`[build] ${OUT}/ ready (${store ? 'store' : 'development'} build)`);
    return;
  }

  const contexts = await Promise.all(options.map((option) => esbuild.context(option)));
  await Promise.all(contexts.map((context) => context.watch()));

  // esbuild watches what the bundles import. Pages, the stylesheet, the manifest and `public/`
  // are not imported by anything, so they get a watcher of their own.
  let pending = null;
  const recopy = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      copyStatic()
        .then(() => console.log('[build] static files copied'))
        .catch((error) => console.error('[build] could not copy static files:', error.message));
    }, 100);
  };
  watch('src', (_event, file) => { if (/\.(html|css|json)$/.test(file ?? '')) recopy(); });
  watch('public', { recursive: true }, recopy);
  console.log(`[build] watching; ${OUT}/ is ready to load`);
}

main().catch((error) => {
  console.error('[build] failed:', error.message ?? error);
  process.exit(1);
});
