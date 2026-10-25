// The OpenPosse tab group: one per window, optional, and a preference rather than a fence.
//
// **Holding the `tabGroups` permission is the setting**, the way holding `favicon` is the site
// icons setting (see favicons.js). It is an optional permission because as a required one Chrome
// shows a new install warning, "View and manage your tab groups", and an update that adds a
// warning disables the extension for everyone until they approve it again (checked with
// `management.getPermissionWarningsByManifest` on Chromium 153, 2026-10-25). So Chrome asks once,
// when somebody switches grouping on, and nothing changes for anybody who leaves it off. Revoking
// it in chrome://extensions turns grouping off, with no stored flag left to disagree.
//
// **Grouping never opens a tab, moves one between windows, or takes one out of somebody's own
// group.** A tab joins the group when it is lassoed and when a question goes to it, so one dragged
// out comes back on next use. A pinned tab cannot be grouped and is skipped. A tab already in a
// group that is not ours is left there.
//
// **The group is found by its title, in its window.** The ids under `grouping.groupIds` are only
// a cache: Chrome gives a group a new id when the browser restarts, and a group somebody renamed
// is theirs now, so a cached id is used only while it still names a group called OpenPosse in
// that window, and a fresh group is made when none does.
//
// Turning it off ungroups the tabs, and never closes one.

export const GROUPING = { permissions: ['tabGroups'] };
export const GROUP_TITLE = 'OpenPosse';
// Fixed, and the logo's orange, by the owner's choice of 2026-10-25. Claude in Chrome's group is
// orange too, which the design avoided; the owner's call is that not everyone uses Claude.
export const GROUP_COLOUR = 'orange';

const KEY = 'grouping';
const NONE = -1;

/** Whether grouping is on: the permission is held. */
export async function groupingOn() {
  try {
    return await chrome.permissions.contains(GROUPING);
  } catch (error) {
    console.warn('[openposse] could not read the tab group permission –', error?.message ?? error);
    return false;
  }
}

/** What is stored: whether the question was answered on the welcome page, and the id cache. */
export async function groupingState() {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return {
    asked: stored?.asked === true,
    groupIds: stored?.groupIds && typeof stored.groupIds === 'object' ? stored.groupIds : {},
  };
}

async function saveState(changes) {
  const state = await groupingState();
  await chrome.storage.local.set({ [KEY]: { ...state, ...changes } });
}

/** Records that the welcome page's question was answered, either way. */
export async function markGroupingAsked() {
  await saveState({ asked: true });
}

/** A group is ours while it is called OpenPosse. Pure, so it can be tested. */
export const isOurs = (group) => group?.title === GROUP_TITLE;

/** Our group in a window, or null. A cached id that no longer names one is not used. */
async function ourGroup(windowId) {
  const { groupIds } = await groupingState();
  const cached = groupIds[windowId];
  if (cached !== undefined) {
    const group = await chrome.tabGroups.get(cached).catch((error) => {
      // Gone: closed, or the browser restarted and the ids changed. Looked up by title below.
      console.debug('[openposse] cached tab group is gone –', error?.message ?? error);
      return null;
    });
    if (group && isOurs(group) && group.windowId === windowId) return group;
  }
  const [found] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
  return found ?? null;
}

/** The ids of every OpenPosse group open now, in any window. Empty with grouping off. */
export async function ourGroupIds() {
  if (!await groupingOn()) return new Set();
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return new Set(groups.map((group) => group.id));
}

/**
 * Puts a tab in its window's OpenPosse group, making the group if there is none.
 *
 * Returns what happened, for the caller to say if it wants: `off`, `pinned`, `own` (left in
 * somebody's own group), `already`, or `grouped`. Throws only when Chrome refuses, with Chrome's
 * error, and when the tab is not in our group afterwards.
 */
export async function joinGroup(tabId) {
  if (!await groupingOn()) return 'off';
  const tab = await chrome.tabs.get(tabId);
  if (tab.pinned) return 'pinned';
  if (tab.groupId !== NONE) {
    const current = await chrome.tabGroups.get(tab.groupId);
    return isOurs(current) ? 'already' : 'own';
  }

  const existing = await ourGroup(tab.windowId);
  let groupId;
  if (existing) {
    groupId = await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOUR, collapsed: false });
  }

  // Checked rather than assumed: the group and the tab are both the user's to change at any time.
  const after = await chrome.tabs.get(tab.id);
  if (after.groupId !== groupId) throw new Error(`tab ${tab.id} is not in the OpenPosse group after grouping`);

  const { groupIds } = await groupingState();
  await saveState({ groupIds: { ...groupIds, [tab.windowId]: groupId } });
  return 'grouped';
}

/** Opens the group a tab is in, so "show me" lands on a tab that can be seen. */
export async function expandGroupOf(tabId) {
  if (!await groupingOn()) return;
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId === NONE) return;
  const group = await chrome.tabGroups.get(tab.groupId);
  if (group.collapsed) await chrome.tabGroups.update(group.id, { collapsed: false });
}

/** Takes these tabs out of the OpenPosse group, if they are in it. Never closes one. */
export async function leaveGroup(tabIds) {
  const ours = await ourGroupIds();
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  const leaving = tabs.filter((tab) => ours.has(tab.groupId)).map((tab) => tab.id);
  if (leaving.length) await chrome.tabs.ungroup(leaving);
}

/**
 * Ungroups every tab in every OpenPosse group, and forgets the cache. Turning grouping off calls
 * this *before* giving up the permission, which is what it needs to find the groups.
 */
export async function ungroupAll() {
  const ours = await ourGroupIds();
  if (ours.size) {
    const tabs = await chrome.tabs.query({});
    const grouped = tabs.filter((tab) => ours.has(tab.groupId)).map((tab) => tab.id);
    if (grouped.length) await chrome.tabs.ungroup(grouped);
  }
  await saveState({ groupIds: {} });
}

/** Turns grouping off: ungroups, then gives the permission back. */
export async function turnGroupingOff() {
  await ungroupAll();
  await chrome.permissions.remove(GROUPING);
}

/**
 * Drops cached ids that no longer name an OpenPosse group: closed, renamed (theirs now), or from
 * before a restart. Run when the worker starts and when a group changes.
 */
export async function reconcileGroups() {
  if (!await groupingOn()) return;
  const { groupIds } = await groupingState();
  const kept = {};
  for (const [windowId, groupId] of Object.entries(groupIds)) {
    const group = await chrome.tabGroups.get(groupId).catch((error) => {
      console.debug('[openposse] dropping a tab group that is gone –', error?.message ?? error);
      return null;
    });
    if (group && isOurs(group) && String(group.windowId) === windowId) kept[windowId] = groupId;
  }
  await saveState({ groupIds: kept });
}
