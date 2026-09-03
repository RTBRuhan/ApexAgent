/*
  One definition of what an editor is allowed to do, shared by the popup that writes it and the
  service worker that enforces it.

  Version 1's permission object was consulted in three places out of 2831 lines, and all three
  read `if (!permission && agentEnabled)` — so switching the agent off skipped the check entirely.
  The lesson encoded here is that the check must be a single function nobody can accidentally
  invert, and that its default answer must be "no". Every path into it either finds an explicit
  `true` or denies.

  Writer/reader split, so two processes never clobber each other: the popup is the only writer of
  `apexPolicy`; the service worker only ever reads it. The popup additionally sends
  `apex:setPermission` after each write so the worker can drop a cached copy immediately instead
  of waiting for a storage event.
*/

export const POLICY_KEY = 'apexPolicy';

/*
  Order matters only for the popup's rendering; enforcement is by key. Each key is a *capability*
  rather than a tool name, because tools get renamed and consolidated and a user should not have
  to re-decide anything when they do.
*/
export const PERMISSION_KEYS = [
  'navigation',
  'input',
  'screenshots',
  'javascript',
  'trustedInput',
  'readPage',
  'otherExtensions',
  'extensionFiles'
];

/*
  Defaults are chosen so a fresh install is useful without being surprising. The four capabilities
  an agent needs to look at a page and drive it are on. The four that are either irreversible,
  visible to the user in a way that needs explaining first, or reach outside the current page are
  off, and the user turns them on once they know why they want them.
*/
export const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  permissions: Object.freeze({
    navigation: true,
    input: true,
    screenshots: true,
    readPage: true,
    javascript: false,
    trustedInput: false,
    otherExtensions: false,
    extensionFiles: false
  })
});

/*
  Coerce anything — missing, corrupt, half-written, or from an older version that had different
  keys — into a complete policy where every field is a real boolean. `=== true` rather than a
  truthiness test is deliberate: a stray string, a 1, or an undefined all mean "not granted".
*/
export function normalisePolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawPermissions =
    source.permissions && typeof source.permissions === 'object' ? source.permissions : {};
  const permissions = {};
  for (const key of PERMISSION_KEYS) {
    permissions[key] = rawPermissions[key] === true;
  }
  return {
    enabled: source.enabled === true,
    permissions,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : 0
  };
}

/*
  The single enforcement point. An unknown capability name denies, so adding a tool without
  deciding which capability governs it fails loudly in testing rather than shipping ungoverned.
*/
export function isAllowed(policy, capability) {
  const normalised = normalisePolicy(policy);
  if (!normalised.enabled) return false;
  if (!PERMISSION_KEYS.includes(capability)) return false;
  return normalised.permissions[capability] === true;
}

export async function readPolicy() {
  const stored = await chrome.storage.local.get(POLICY_KEY);
  return normalisePolicy(stored[POLICY_KEY]);
}
