// Turning the host of a recorded page into the pattern a lasso is valid for.
//
// Small, dull code with a security consequence, which is why it is its own file with its own
// tests. The pattern derived here becomes an optional host permission *and* a content script's
// `matches` — it decides which sites the extension may read. Deriving it carelessly grants page
// access to sites the user never chose.
//
// **This file is a second implementation, and the first one said not to write it.**
// `service-worker.js` explains that the Mac app sent `prepare_access` with a pattern precisely
// so the extension would never derive one: *"deriving it here would mean a second
// implementation of `DomainPattern` — and a public-suffix mistake in either copy is a grant
// over every site under `co.uk`."* That reasoning was right, and it was about **two copies**
// disagreeing. With the app parked the extension is the only copy, so the hazard is now a
// wrong copy rather than a divergent one — and the port is faithful to
// `Sources/OpenPosseShared/DomainPattern.swift` for that reason. If the Swift ever comes back
// in V2, these two must be diffed, not assumed.
//
// ── The trap is the public suffix ──
//
// "Registrable domain = last two labels" is the obvious rule and it is right for
// `demo-au.leanix.net` → `leanix.net`. Applied to `assistant.example.co.uk` it yields `co.uk`,
// and `*.co.uk` is every commercial site in the United Kingdom. The same mistake gives
// `*.com.au`, `*.co.jp`, `*.com.br`.
//
// A full Public Suffix List would settle it exactly, but it is a ~10,000-line file that goes
// stale and would have to be bundled or fetched — and fetching is out of the question for a
// product whose central claim is that nothing leaves the machine.
//
// So the rule is **conservative rather than exact**: when in doubt it keeps one more label than
// it needs, producing a pattern that is too *narrow*. That asymmetry is the whole design. A
// too-narrow pattern fails **visibly** — the agent does not match the user's tab and the wizard
// says so — while a too-broad one fails **invisibly** and hands out access. Only one of those
// is recoverable by a person who cannot see either.

/**
 * Second-level labels that act as public suffixes under a two-letter country TLD.
 *
 * A list of *these* rather than of full suffixes: ~20 entries instead of thousands, and it
 * generalises, so `co.uk`, `co.jp`, `co.nz` and `co.za` are one entry. New country registries
 * reuse the same handful of labels.
 */
const GENERIC_SECOND_LEVEL = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'mil', 'ac',
  'or', 'ne', 'go', 'sch', 'id', 'nom', 'web', 'info', 'biz', 'in', 'asn',
]);

/** Whether these two labels are a public suffix rather than a registrable domain. */
function isPublicSuffix(labels) {
  if (labels.length !== 2) return false;
  // Two-letter TLDs are the country registries where this convention exists. `.com`, `.net`
  // and the long gTLDs do not sell under `co.` prefixes, so a host like `co.example.com` is an
  // ordinary subdomain and must keep its two-label domain.
  return labels[1].length === 2 && GENERIC_SECOND_LEVEL.has(labels[0]);
}

/** An IP literal has no registrable domain, and `*.192.168` is meaningless. */
function isIPLiteral(host) {
  if (host.includes(':')) return true;            // IPv6, bracketed or not
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * The wildcard pattern for `host`, or the bare host when a wildcard cannot be derived safely.
 *
 * `*.leanix.net` rather than `demo-au.leanix.net` because vendors put each customer on their
 * own subdomain — a LeanIX user moving between `demo-au` and `acme` is talking to the same
 * assistant, and a lasso pinned to one workspace would look broken the moment they switched.
 * Chrome's `*.foo.com` matches `foo.com` itself as well as its subdomains, so the wildcard is a
 * superset of the exact host and never loses the page it was recorded on.
 *
 * Returns the exact host — no wildcard — for an IP address, a single-label host such as
 * `localhost`, or anything where the registrable domain cannot be established.
 */
export function patternForHost(host) {
  const clean = String(host ?? '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!clean) return '';
  if (isIPLiteral(clean)) return clean;

  const labels = clean.split('.');
  if (labels.length < 2) return clean;            // `localhost`, an intranet name

  // Two labels under a generic-second-level ccTLD *is* a public suffix — `co.uk` on its own is
  // not a registrable domain and must never become a pattern.
  if (labels.length === 2 && isPublicSuffix(labels)) return clean;

  const keep = isPublicSuffix(labels.slice(-2)) ? 3 : 2;
  if (labels.length < keep) return clean;

  return `*.${labels.slice(-keep).join('.')}`;
}

/**
 * The Chrome match pattern for a lasso's `domainPattern`.
 *
 * **One definition, used by all three of** the optional host-permission request, the dynamic
 * content-script registration, and the tab query. Those three disagreeing is a silent failure
 * of the worst kind: the permission is granted for one pattern, the script registered for
 * another, and the injection simply never happens — with nothing anywhere reporting a problem.
 */
export function matchPattern(domainPattern) {
  return `https://${domainPattern}/*`;
}
