// The order the roster is drawn in, which is not the order it is stored in.
//
// **The stored list stays in the order assistants were added, and has to.** An agent with no voice
// of its own – every recording and every import, until somebody picks one in Settings – is handed
// one by position, first come first served (`assignVoices`, `assignKokoroVoices`). Rearranging
// that list would change who sounds like whom, with nothing on screen connecting the drag to the
// voice. So the order arranged in Settings is a separate list of ids, and only what draws the
// roster reads it: Settings, the panel and the popup.

/**
 * `agents` in the order `order` lists their ids, as a new list – `agents` itself is left alone.
 *
 * Anyone `order` does not name, added since the roster was last arranged, comes after everyone it
 * does, in the order they were added. The id of somebody since deleted is skipped.
 */
export function inOrder(agents, order) {
  const ids = Array.isArray(order) ? order : [];
  const place = new Map(ids.map((id, i) => [id, i]));
  return agents
    .map((agent, added) => ({ agent, at: place.get(agent.id) ?? ids.length + added }))
    .sort((a, b) => a.at - b.at)
    .map(({ agent }) => agent);
}

/** By name the way a person reads names: "ivan" beside "Ivan", and "Notion 2" before "Notion 10". */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/**
 * The ids of `agents` sorted `how` – `name`, `site`, `newest` or `oldest` – for Settings' Sort menu.
 *
 * `agents` must be in stored order, because the order they were added is the only record of age
 * there is. `siteOf(agent)` is what it drives ("Notion"); an assistant without one – its lasso
 * is missing – goes after those with one, rather than first, where an empty name would sort it.
 */
export function sortedIDs(agents, how, siteOf = () => '') {
  const added = new Map(agents.map((agent, i) => [agent.id, i]));
  const site = (agent) => siteOf(agent) || '';
  const compare = {
    name: byName,
    site: (a, b) => {
      const [x, y] = [site(a), site(b)];
      if (Boolean(x) !== Boolean(y)) return x ? -1 : 1;
      return x.localeCompare(y, undefined, { sensitivity: 'base' }) || byName(a, b);
    },
    newest: (a, b) => added.get(b.id) - added.get(a.id),
    oldest: (a, b) => added.get(a.id) - added.get(b.id),
  }[how];
  if (!compare) throw new Error(`"${how}" is not one of the sorts`);
  return [...agents].sort(compare).map((agent) => agent.id);
}
