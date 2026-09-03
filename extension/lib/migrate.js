/*
  Install/update migrations.

  Version 2 removes the bring-your-own-key chat sidebar. That sidebar rendered model output and
  tool results into the DOM with innerHTML and no escaping, persisted that history, and re-rendered
  it on load — stored cross-site scripting in a context that also held the user's API key. Deleting
  the feature without deleting the key would leave a live credential in storage that nothing can
  use and something could still exfiltrate, so the key goes too.

  Deleting someone's credential is not a thing to do quietly. Every run writes a record of exactly
  which keys existed and were removed, the popup reads that record and tells the user once, and the
  run is logged to the service worker console. The record is also what makes this idempotent: an
  already-applied migration is skipped rather than re-running on every browser start.

  Call this from background.js's chrome.runtime.onInstalled handler and, defensively, from its
  startup path — onInstalled does not fire if a user was already updated by a previous version of
  the extension that never ran the migration.
*/

import { POLICY_KEY, DEFAULT_POLICY, normalisePolicy } from './policy.js';

const RECORD_KEY = 'apexMigrations';

export const MIGRATION_RETIRE_SIDEBAR = '2.0.0-retire-sidebar';
export const MIGRATION_SEED_POLICY = '2.0.0-seed-policy';

/*
  The keys the user is told about. `aiApiKey` is a secret; `chatHistory` is the XSS payload store;
  the rest are settings for a feature that no longer exists.
*/
const SIDEBAR_KEYS = ['aiApiKey', 'aiProvider', 'aiModel', 'chatHistory', 'sidebarState'];

/*
  Leftovers from the same feature that are not worth mentioning to anyone: a boolean flag and a
  UI-state blob. Removed in the same pass so storage does not accumulate archaeology, but kept out
  of the user-facing record so the notice stays about the thing that matters.
*/
const SIDEBAR_DEAD_FLAGS = ['aiEnabled', 'aiSidebarOpen'];

async function readRecord() {
  const stored = await chrome.storage.local.get(RECORD_KEY);
  const record = stored[RECORD_KEY];
  if (!record || typeof record !== 'object') return { applied: [], log: [] };
  return {
    applied: Array.isArray(record.applied) ? record.applied : [],
    log: Array.isArray(record.log) ? record.log : []
  };
}

async function writeRecord(record) {
  await chrome.storage.local.set({ [RECORD_KEY]: record });
}

/*
  Read before remove so the record names only keys that were genuinely present. Reporting a
  deletion that did not happen would make the popup lie to a user who never used the sidebar.
*/
async function retireSidebar() {
  const stored = await chrome.storage.local.get([...SIDEBAR_KEYS, ...SIDEBAR_DEAD_FLAGS]);
  const deletedKeys = SIDEBAR_KEYS.filter((key) => Object.hasOwn(stored, key));
  const deadFlags = SIDEBAR_DEAD_FLAGS.filter((key) => Object.hasOwn(stored, key));

  if (deletedKeys.length || deadFlags.length) {
    await chrome.storage.local.remove([...deletedKeys, ...deadFlags]);
  }

  return {
    id: MIGRATION_RETIRE_SIDEBAR,
    ranAt: Date.now(),
    deletedKeys,
    hadCredential: deletedKeys.includes('aiApiKey')
  };
}

/*
  Enforcement fails closed, which means an unseeded install would refuse everything and look
  broken for reasons no user could diagnose. Seeding the documented defaults at install time is
  what keeps "deny unless explicitly true" from being a footgun. An existing policy is left
  exactly as the user set it, including any capability they deliberately switched off.
*/
async function seedPolicy() {
  const stored = await chrome.storage.local.get(POLICY_KEY);
  const existing = stored[POLICY_KEY];
  const alreadySet = existing && typeof existing === 'object';

  if (!alreadySet) {
    await chrome.storage.local.set({
      [POLICY_KEY]: normalisePolicy({ ...DEFAULT_POLICY, updatedAt: Date.now() })
    });
  }

  return { id: MIGRATION_SEED_POLICY, ranAt: Date.now(), seeded: !alreadySet };
}

export async function runMigrations() {
  const record = await readRecord();
  const applied = new Set(record.applied);
  const ran = [];

  if (!applied.has(MIGRATION_RETIRE_SIDEBAR)) {
    const entry = await retireSidebar();
    applied.add(entry.id);
    record.log.push(entry);
    ran.push(entry);
    console.info(
      '[apex] migration %s removed %d stored key(s): %s',
      entry.id,
      entry.deletedKeys.length,
      entry.deletedKeys.join(', ') || 'none present'
    );
  }

  if (!applied.has(MIGRATION_SEED_POLICY)) {
    const entry = await seedPolicy();
    applied.add(entry.id);
    record.log.push(entry);
    ran.push(entry);
    console.info(
      '[apex] migration %s %s',
      entry.id,
      entry.seeded ? 'seeded default permissions' : 'left existing permissions untouched'
    );
  }

  if (ran.length) {
    await writeRecord({ applied: [...applied], log: record.log.slice(-20) });
  }

  return { ran, applied: [...applied] };
}
