// What makes the beta build "OpenPosse Beta": a separate Chrome Web Store item from OpenPosse,
// published on every merge to main.
//
// The store refuses an upload whose version is not higher than the last one it took, and the
// release version only moves when release-please moves it. So a beta carries a fourth number,
// the build: 0.3.1.12 is the twelfth beta built from 0.3.1, and every beta of 0.3.2 sorts after
// every beta of 0.3.1. Chrome allows up to four numbers in a version, each 0–65535.

/** The largest number Chrome accepts in one part of a version. */
export const MAX_PART = 65535;

/**
 * The store manifest, renamed and renumbered for the beta item.
 *
 * @param {object} manifest the store manifest, already without `key`
 * @param {string | number | undefined} build `BETA_BUILD`: the beta workflow's run number, or 0
 *   for the package uploaded by hand to create the item
 */
export function betaManifest(manifest, build) {
  const text = String(build ?? '').trim();
  // Required rather than defaulted: a beta run that lost its build number would upload the same
  // version every time, and the store would refuse all but the first with a less useful message.
  if (!/^\d+$/.test(text) || Number(text) > MAX_PART) {
    throw new Error(`BETA_BUILD must be a whole number from 0 to ${MAX_PART}, not "${build ?? ''}"`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`a beta is numbered from a three-part release version, not ${manifest.version}`);
  }

  const number = Number(text);
  return {
    ...manifest,
    name: `${manifest.name} Beta`,
    version: `${manifest.version}.${number}`,
    // What chrome://extensions shows. "0.3.1 beta 12" reads as what it is; "0.3.1.12" does not.
    version_name: `${manifest.version} beta ${number}`,
    // The toolbar tooltip, so a tester with both installed can tell them apart.
    ...(manifest.action && {
      action: { ...manifest.action, default_title: `${manifest.action.default_title} Beta` },
    }),
  };
}
