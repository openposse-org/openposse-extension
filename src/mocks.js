// Made-up recordings, for seeing a full roster without recording thirty vendors.
//
// A debug tool, reached from the panel's debug drawer. **They are written into the real roster**,
// flagged `mock`, because that is the only way every surface draws them exactly as it would draw
// real ones: the panel's avatars, Settings, colours past the sixteenth, initials that repeat.
// Taking them out removes the flagged agents and nothing else – see `setMockRoster`.
//
// They cannot answer. The selectors name nothing on any real page, so asking one fails the way a
// broken recipe does, which is worth being able to see too.

export const MOCK_SIZES = [10, 20, 30];

/**
 * Who they are and what they pretend to drive, paired by position.
 *
 * The two long names come early, so even the smallest roster has to lay them out. The repeated
 * initials are deliberate: a long roster has them, and the avatars should be judged with them.
 * No vendor here is one somebody has likely recorded for real, so "take me to Notion" still means
 * the real Notion agent while mocks are in.
 */
const CAST = [
  ['Maya', 'salesforce.com'], ['Theo', 'zendesk.com'], ['Ines', 'asana.com'],
  ['Bartholomew', 'linear.app'], ['Kofi', 'miro.com'], ['Lena', 'figma.com'],
  ['Data Team', 'slack.com'], ['Omar', 'basecamp.com'], ['Sofia', 'workday.com'],
  ['Ravi', 'intercom.com'], ['Hana', 'airtable.com'], ['Felix', 'coda.io'],
  ['Zara', 'dropbox.com'], ['Mateo', 'zoom.us'], ['Yuki', 'canva.com'],
  ['Nadia', 'gong.io'], ['Arjun', 'glean.com'], ['Clara', 'monday.com'],
  ['Emeka', 'freshdesk.com'], ['Lucia', 'pipedrive.com'], ['Tomas', 'smartsheet.com'],
  ['Aisha', 'webflow.com'], ['Jonas', 'retool.com'], ['Mei', 'sentry.io'],
  ['Diego', 'okta.com'], ['Freya', 'shopify.com'], ['Kenji', 'lattice.com'],
  ['Leila', 'greenhouse.io'], ['Oskar', 'typeform.com'], ['Amara', 'trello.com'],
];

/** A recipe that passes every check Settings runs, on selectors no page has. */
const mockRecipe = (domain) => ({
  domainPattern: `*.${domain}`,
  openMethod: 'click',
  openSelector: '[data-openposse-mock="open"]',
  inputSelector: '[data-openposse-mock="input"]',
  submitMethod: 'click',
  submitSelector: '[data-openposse-mock="send"]',
  responseContainerSelector: '[data-openposse-mock="reply"]',
});

/** The recordings that fill a roster of `real` agents up to `size` – none if it is already there. */
export function mockRecordings(real, size) {
  return CAST.slice(0, Math.max(0, size - real))
    .map(([name, domain]) => ({ name, recipe: mockRecipe(domain) }));
}
