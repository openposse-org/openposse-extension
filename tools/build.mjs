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
//   node tools/build.mjs --beta     the store build, named "OpenPosse Beta" and numbered with
//                                   `BETA_BUILD` as a fourth part, for the beta item. See
//                                   `tools/beta.mjs` and docs/releasing.md.
//   node tools/build.mjs --e2e      for the browser tests: a development build in `dist-e2e/`
//                                   whose manifest grants the test vendor's made-up site. Never
//                                   loaded by hand and never shipped; see `E2E_SITE`.

import * as esbuild from 'esbuild';
import { watch } from 'node:fs';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { betaManifest } from './beta.mjs';

const beta = process.argv.includes('--beta');
// A beta is a store build under another name, so everything a store build leaves out, it does too.
const store = process.argv.includes('--store') || beta;
const e2e = process.argv.includes('--e2e');
const watching = process.argv.includes('--watch');
const OUT = e2e ? 'dist-e2e' : 'dist';

/**
 * The site the browser tests' fake vendor is served at, granted in the e2e build's manifest.
 *
 * A real build is granted a site by the person clicking Allow in Chrome's own dialog, which
 * automation cannot reach. Granting it in the manifest stands in for that click. The service
 * worker does not register the vendor script for a site the manifest lists (`staticOrigins`);
 * a turn injects it when it needs it, which is the path the tests drive.
 */
const E2E_SITE = 'https://*.fixture.test/*';

if (store && e2e) {
  console.error(`[build] failed: --${beta ? 'beta' : 'store'} and --e2e are different builds; pick one`);
  process.exit(1);
}

/** Module pages and the service worker. */
const MODULES = {
  'service-worker': 'src/service-worker.js',
  setup: 'src/setup.js',
  popup: 'src/popup.js',
  sidepanel: 'src/sidepanel.js',
  offscreen: 'src/offscreen.js',
  spike: 'src/spike.js',
  'supertonic-spike': 'src/supertonic-spike.js',
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
const DEV_ONLY = new Set([
  'spike', 'spike.html', 'supertonic-spike', 'supertonic-spike.html', 'capture',
]);

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

  // Supertonic's helper is bundled into the offscreen page rather than copied, so its MIT licence
  // would otherwise be the one vendored licence missing from the package.
  await cp('src/supertonic/LICENSE', `${OUT}/vendor/supertonic/LICENSE`);

  let manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  // Two version numbers that can disagree eventually will. The manifest's is the one Chrome and
  // the store read; release tooling bumps both, and this stops a hand edit getting past one.
  if (manifest.version !== version) {
    throw new Error(`manifest.json says ${manifest.version} but package.json says ${version}`);
  }
  if (store) delete manifest.key;
  if (beta) manifest = betaManifest(manifest, process.env.BETA_BUILD);
  if (e2e) manifest.host_permissions = [E2E_SITE];
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
    const kind = beta ? 'beta' : store ? 'store' : e2e ? 'browser-test' : 'development';
    console.log(`[build] ${OUT}/ ready (${kind} build)`);
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
