/*
  Popup controller.

  Two rules shape this file. First, nothing that could have come from a page, a tool result, a
  model, or storage is ever handed to innerHTML — every value goes in through textContent or an
  attribute set by the DOM API. That is the exact sink that made the old chat sidebar dangerous,
  and a popup that renders tab titles and tool arguments is squarely in range of the same class of
  bug. Second, this window never asserts anything it has not been told: if the service worker does
  not answer, the panel says so rather than showing a stale or optimistic "connected".
*/

import { EDITOR_TARGETS, findEditorTarget } from '../lib/editor-setup.js';
import { POLICY_KEY, PERMISSION_KEYS, DEFAULT_POLICY, normalisePolicy } from '../lib/policy.js';
import { describeState } from '../lib/connection-copy.js';

const PAIRING_WINDOW_MS = 120000;
const REFRESH_MS = 2000;
const ACTIVITY_LIMIT = 8;
const NOTICE_ID = 'sidebarRemoved';

/*
  Capability copy. Every line answers the same question — what stops working if this is off —
  because that is the only thing a person can actually weigh. No tool names, no protocol words.
*/
const CAPABILITY_COPY = [
  {
    key: 'navigation',
    label: 'Navigation',
    say: 'Open pages, follow links, go back. Off: your assistant cannot move you between pages.'
  },
  {
    key: 'input',
    label: 'Clicking and typing',
    say: 'Press buttons and fill in fields. Off: your assistant can read a page but not act on it.'
  },
  {
    key: 'screenshots',
    label: 'Screenshots',
    say: 'Capture what a page looks like. Off: your assistant works from text only and cannot check layout.'
  },
  {
    key: 'javascript',
    label: 'Run JavaScript',
    say: 'Run code your assistant writes inside the page. Off: expression and script tools fail. Leave off unless you need it.'
  },
  {
    key: 'trustedInput',
    label: 'Trusted input and deep inspection',
    say: 'Uses Chrome’s built-in debugger, the same one DevTools uses, so clicks and keystrokes look real to the page and network and console history become readable. While it is attached Chrome shows a yellow bar at the top of the window reading that Apex Agent is debugging this browser. That bar is Chrome being honest with you, and it goes away when the work finishes. Off: clicks and typing are simulated, which some sites ignore, and network history is unavailable.'
  },
  {
    key: 'readPage',
    label: 'Read page data',
    say: 'Read text, form values, and site storage on the page you are on. Off: your assistant is effectively blind and most tools return nothing.'
  },
  {
    key: 'otherExtensions',
    label: 'Other extensions',
    say: 'List and reload your other extensions. Off: extension-development tools stop working. Ordinary web work is unaffected.'
  },
  {
    key: 'extensionFiles',
    label: 'Extension file access',
    say: 'Read the source files of an unpacked extension you are developing. Off: source-reading tools fail. Ordinary web work is unaffected.'
  }
];

/*
  Failure phrasing for the activity log. Same principle as the connection states: the log is for a
  person deciding whether to trust this thing, so it reports what happened, not an error constant.
*/
const OUTCOME_PHRASES = {
  NOT_ALLOWED: 'not allowed',
  NO_TAB: 'no tab chosen',
  UNSUPPORTED_URL: 'page off limits',
  NOT_FOUND: 'nothing matched',
  AMBIGUOUS: 'too many matches',
  STALE_REF: 'page had changed',
  NODE_DETACHED: 'page had changed',
  OCCLUDED: 'target covered',
  NOT_INTERACTABLE: 'target inactive',
  TIMEOUT: 'timed out',
  CANCELLED: 'cancelled',
  CDP_REQUIRED: 'needs trusted input',
  CDP_DETACHED: 'debugger detached',
  TAB_CRASHED: 'tab crashed',
  BAD_PARAMS: 'bad request',
  TOO_LARGE: 'result too big',
  NO_EXTENSION: 'browser not attached',
  NOT_PAIRED: 'not approved yet',
  EXTENSION_BUSY: 'too busy',
  INTERNAL: 'internal fault'
};

const dom = {};
let currentTab = null;
let pairingTicker = null;
let permissionRows = new Map();
/*
  Signatures of the last thing rendered for the two lists. The panel re-reads state every couple of
  seconds, and rebuilding a list that has not changed would move focus out of a button the user is
  tabbing towards and make a screen reader re-announce identical text. Cheap comparison, no churn.
*/
const lastRender = { clients: null, activity: null, code: null };

function grab(...ids) {
  for (const id of ids) dom[id] = document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function show(node, visible) {
  node.hidden = !visible;
}

/* Assigning textContent replaces the text node even when the string is identical, which inside an
   aria-live region reads as a fresh announcement. So only write when the value really changed. */
function setText(node, text) {
  const next = text === undefined || text === null ? '' : String(text);
  if (node.textContent !== next) node.textContent = next;
}

/* ---------- talking to the service worker ---------- */

/*
  A rejected sendMessage means the worker is gone or threw before replying, which is a different
  situation from any connection state the worker could report — so it maps to its own state rather
  than being folded into "not running". Returning null here is what makes that distinction
  possible upstream.
*/
async function send(type, fields = {}) {
  try {
    const reply = await chrome.runtime.sendMessage({ type, ...fields });
    return reply === undefined ? null : reply;
  } catch (error) {
    console.warn('[apex] popup message failed', type, error);
    return null;
  }
}

/* ---------- status ---------- */

function renderStatus(state) {
  const view = describeState(state);

  dom.statusBlock.dataset.state = view.key;
  setText(dom.stateWord, view.word);
  setText(dom.stateSay, view.say);

  if (view.command) {
    if (dom.stateExtra.dataset.command !== view.command) {
      clear(dom.stateExtra);
      dom.stateExtra.append(el('code', null, view.command));
      dom.stateExtra.dataset.command = view.command;
    }
    show(dom.stateExtra, true);
  } else {
    show(dom.stateExtra, false);
  }

  show(dom.reconnectBtn, view.offerReconnect);
  show(dom.openExtensionsBtn, view.offerExtensionsPage);

  const detail = typeof state.detail === 'string' ? state.detail.trim() : '';
  setText(dom.stateDetail, detail);
  show(dom.stateTech, detail.length > 0);
  if (!detail) dom.stateTech.open = false;
}

/* ---------- pairing ---------- */

function renderPairing(state) {
  const pairing = state.pairing;
  const code = pairing && typeof pairing.code === 'string' ? pairing.code : '';

  if (!code) {
    show(dom.pairingBlock, false);
    lastRender.code = null;
    stopPairingTicker();
    return;
  }

  show(dom.pairingBlock, true);

  if (lastRender.code !== code) {
    lastRender.code = code;
    show(dom.pairError, false);

    clear(dom.pairCode);
    const spoken = el('span', 'sr-only', [...code].join(' '));
    dom.pairCode.append(spoken);
    [...code].forEach((digit, index) => {
      if (index === 3) dom.pairCode.append(el('span', 'pair-gap'));
      const cell = el('span', 'pair-digit', digit);
      cell.setAttribute('aria-hidden', 'true');
      dom.pairCode.append(cell);
    });

    dom.approveBtn.disabled = false;
    dom.rejectBtn.disabled = false;
    dom.approveBtn.dataset.code = code;
    dom.rejectBtn.dataset.code = code;

    startPairingTicker(pairing.expiresAt);
  }
}

/*
  The countdown is derived from an absolute expiry timestamp rather than the "expiresInMs" the hub
  puts on the wire, because the popup may be opened a minute after the frame arrived and a relative
  number would restart the clock at 120 seconds every time this window opens.
*/
function startPairingTicker(expiresAt) {
  stopPairingTicker();
  const tick = () => {
    const remaining = Number.isFinite(expiresAt) ? expiresAt - Date.now() : PAIRING_WINDOW_MS;
    const clamped = Math.max(0, remaining);
    const fraction = Math.max(0, Math.min(1, clamped / PAIRING_WINDOW_MS));
    dom.expiryFill.style.width = `${(fraction * 100).toFixed(1)}%`;

    if (clamped <= 0) {
      dom.expiryText.textContent = 'This code has expired. Restart your editor for a new one.';
      dom.approveBtn.disabled = true;
      stopPairingTicker();
      return;
    }
    const seconds = Math.ceil(clamped / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, '0');
    dom.expiryText.textContent = `Expires in ${minutes}:${rest}`;
  };
  tick();
  pairingTicker = setInterval(tick, 1000);
}

function stopPairingTicker() {
  if (pairingTicker) {
    clearInterval(pairingTicker);
    pairingTicker = null;
  }
}

async function decidePairing(approve) {
  const button = approve ? dom.approveBtn : dom.rejectBtn;
  const code = button.dataset.code || '';
  dom.approveBtn.disabled = true;
  dom.rejectBtn.disabled = true;

  const reply = await send(approve ? 'apex:approvePairing' : 'apex:rejectPairing', { code });

  if (!reply || reply.ok !== true) {
    const message = reply && reply.error && typeof reply.error.message === 'string'
      ? reply.error.message
      : 'That did not go through. Restart your editor to get a new code.';
    dom.pairError.textContent = message;
    show(dom.pairError, true);
    dom.rejectBtn.disabled = false;
  }

  await refresh();
}

/* ---------- attached editors ---------- */

function tabLabel(client) {
  if (client.tabTitle) return client.tabTitle;
  if (client.tabUrl) return client.tabUrl;
  if (Number.isFinite(client.tabId)) return `tab ${client.tabId}`;
  return 'no tab chosen — it will use whichever tab is in front';
}

function renderClients(state) {
  const clients = Array.isArray(state.clients) ? state.clients : [];
  const signature = JSON.stringify([clients, currentTab && currentTab.id]);
  if (lastRender.clients === signature) return;
  lastRender.clients = signature;

  clear(dom.clientList);

  setText(dom.clientCount, clients.length ? String(clients.length) : '');
  show(dom.clientEmpty, clients.length === 0);

  for (const client of clients) {
    const row = el('li', 'client');
    const identity = el('div', 'client-id');

    const name = el('p', 'client-name', client.name || client.clientId || 'Unnamed editor');
    if (client.version) name.title = `${client.name || 'editor'} ${client.version}`;
    identity.append(name);

    const target = el('p', 'client-tab', tabLabel(client));
    target.title = client.tabUrl || '';
    identity.append(target);
    row.append(identity);

    /*
      "Use this tab" is the concrete answer to "which tab will they act on". It is offered only
      when it would change something, and never for pages extensions are not allowed to touch,
      because a button whose only outcome is a refusal is worse than no button.
    */
    const targetable = currentTab && Number.isFinite(currentTab.id) && isTargetable(currentTab.url);
    if (targetable && client.tabId !== currentTab.id) {
      const pick = el('button', 'btn btn-tiny', 'Use this tab');
      pick.type = 'button';
      pick.addEventListener('click', async () => {
        pick.disabled = true;
        await send('apex:selectTab', { clientId: client.clientId, tabId: currentTab.id });
        await refresh();
      });
      row.append(pick);
    } else if (currentTab && client.tabId === currentTab.id) {
      row.append(el('span', 'client-here', 'this tab'));
    }

    dom.clientList.append(row);
  }
}

function isTargetable(url) {
  if (typeof url !== 'string' || url === '') return false;
  return /^(https?|file|about:blank)/.test(url) &&
    !url.startsWith('https://chromewebstore.google.com') &&
    !url.startsWith('https://chrome.google.com/webstore');
}

/* ---------- capabilities ---------- */

function buildPermissionRows() {
  clear(dom.permList);
  permissionRows = new Map();

  /*
    Iterating the shared key list rather than the copy list means a capability added to the policy
    can never quietly go unrendered — it shows up here with its raw key, which is ugly enough that
    it gets noticed and given real copy.
  */
  for (const key of PERMISSION_KEYS) {
    const copy = CAPABILITY_COPY.find((entry) => entry.key === key) ||
      { key, label: key, say: 'No description yet.' };

    const row = el('li', 'perm');
    const text = el('div', 'perm-text');

    const label = el('label', 'perm-label', copy.label);
    label.htmlFor = `perm-${key}`;
    text.append(label);

    const say = el('p', 'perm-say', copy.say);
    say.id = `perm-${key}-say`;
    text.append(say);
    row.append(text);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'switch';
    box.id = `perm-${key}`;
    box.setAttribute('role', 'switch');
    box.setAttribute('aria-describedby', say.id);
    box.addEventListener('change', () => setPermission(key, box.checked));
    row.append(box);

    dom.permList.append(row);
    permissionRows.set(key, box);
  }
}

function renderPolicy(policy) {
  dom.masterSwitch.checked = policy.enabled;
  for (const [key, box] of permissionRows) {
    box.checked = policy.permissions[key] === true;
  }

  const allowed = PERMISSION_KEYS.filter((key) => policy.permissions[key] === true).length;
  setText(
    dom.permSummary,
    policy.enabled ? `${allowed} of ${PERMISSION_KEYS.length} allowed` : 'paused'
  );
  setText(
    dom.masterSay,
    policy.enabled
      ? 'Turn this off to refuse everything without disconnecting.'
      : 'Every request is being refused. Editors stay connected and will be told they were refused.'
  );
  show(dom.pausedNote, !policy.enabled);
}

/*
  The popup is the only writer of the policy, so a write is a read-modify-write of the whole
  object. The message afterwards is not the mechanism — storage is — it exists so the worker drops
  any cached copy immediately rather than acting on a stale one for the next few milliseconds.
*/
async function writePolicy(mutate) {
  const stored = await chrome.storage.local.get(POLICY_KEY);
  const policy = normalisePolicy(stored[POLICY_KEY]);
  mutate(policy);
  policy.updatedAt = Date.now();
  await chrome.storage.local.set({ [POLICY_KEY]: policy });
  renderPolicy(policy);
  return policy;
}

async function setPermission(key, value) {
  const policy = await writePolicy((draft) => {
    draft.permissions[key] = value === true;
  });
  const reply = await send('apex:setPermission', { key, value: value === true });
  /*
    If the worker reports a different effective policy than we just wrote, it wins: it is the one
    enforcing, and showing the user a switch that does not match what is enforced is precisely the
    failure this rewrite exists to remove.
  */
  if (reply && reply.permissions) {
    renderPolicy(normalisePolicy({ enabled: reply.agentEnabled, permissions: reply.permissions }));
  } else {
    renderPolicy(policy);
  }
}

async function setMaster(value) {
  const policy = await writePolicy((draft) => {
    draft.enabled = value === true;
  });
  const reply = await send('apex:setPermission', { key: 'enabled', value: value === true });
  if (reply && reply.permissions) {
    renderPolicy(normalisePolicy({ enabled: reply.agentEnabled, permissions: reply.permissions }));
  } else {
    renderPolicy(policy);
  }
}

/* ---------- activity ---------- */

function outcomeWords(entry) {
  if (entry.ok === true) return 'done';
  const phrase = OUTCOME_PHRASES[entry.code];
  return phrase ? phrase : 'failed';
}

function clockTime(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function renderActivity(entries) {
  const list = Array.isArray(entries) ? entries.slice(0, ACTIVITY_LIMIT) : [];
  const signature = JSON.stringify(list);
  if (lastRender.activity === signature) return;
  lastRender.activity = signature;

  clear(dom.activityList);

  show(dom.activityEmpty, list.length === 0);
  setText(
    dom.activitySummary,
    list.length ? `${list[0].tool || 'request'} · ${outcomeWords(list[0])}` : 'nothing yet'
  );

  for (const entry of list) {
    const row = el('li', 'activity');
    row.dataset.ok = String(entry.ok === true);

    row.append(el('p', 'activity-tool', entry.tool || 'request'));
    row.append(el('p', 'activity-outcome', outcomeWords(entry)));

    const where = [entry.clientName, entry.tabTitle || (Number.isFinite(entry.tabId) ? `tab ${entry.tabId}` : null)]
      .filter(Boolean)
      .join(' → ');
    const whereNode = el('p', 'activity-where', where || 'this browser');
    whereNode.title = entry.tabUrl || '';
    row.append(whereNode);

    row.append(el('p', 'activity-when', clockTime(entry.ts)));
    dom.activityList.append(row);
  }
}

/* ---------- editor setup ---------- */

function buildEditorPicker(selectedId) {
  clear(dom.editorOptions);
  for (const target of EDITOR_TARGETS) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'editor';
    input.id = `editor-${target.id}`;
    input.value = target.id;
    input.checked = target.id === selectedId;
    input.addEventListener('change', () => {
      renderEditorTarget(target.id);
      chrome.storage.local.set({ apexSetupEditor: target.id });
    });

    const label = el('label', null, target.label);
    label.htmlFor = input.id;

    dom.editorOptions.append(input, label);
  }
}

function renderEditorTarget(id) {
  const target = findEditorTarget(id);
  dom.setupPath.textContent = target.path;
  dom.setupNote.textContent = target.note;
  dom.setupSnippet.textContent = target.snippet;
  dom.setupSnippet.setAttribute('aria-label', `${target.label} configuration, ${target.language}`);
  dom.copyBtn.dataset.editor = target.id;
  dom.copyStatus.textContent = '';
}

async function copySnippet() {
  const text = dom.setupSnippet.textContent;
  try {
    await navigator.clipboard.writeText(text);
    dom.copyStatus.textContent = 'Copied';
  } catch {
    dom.copyStatus.textContent = 'Could not copy — select the text and press Ctrl+C';
  }
  setTimeout(() => {
    dom.copyStatus.textContent = '';
  }, 2500);
}

/* ---------- the one-time notice ---------- */

async function renderNotice() {
  const stored = await chrome.storage.local.get(['apexMigrations', 'apexNotices']);
  const log = stored.apexMigrations && Array.isArray(stored.apexMigrations.log)
    ? stored.apexMigrations.log
    : [];
  const entry = log.find((item) => item && item.id === '2.0.0-retire-sidebar');
  const dismissed = Boolean(
    stored.apexNotices && stored.apexNotices[NOTICE_ID] && stored.apexNotices[NOTICE_ID].dismissedAt
  );

  const deleted = entry && Array.isArray(entry.deletedKeys) ? entry.deletedKeys : [];
  if (dismissed || deleted.length === 0) {
    show(dom.notice, false);
    return;
  }

  const parts = ['Apex Agent’s built-in chat panel has been removed — your editor does that job better, and the panel had a security flaw in how it displayed replies.'];
  if (entry.hadCredential) {
    parts.push('The API key you had saved in it was deleted at the same time, so nothing is left behind that could leak. You will need to keep it wherever you got it from if you still want it.');
  } else {
    parts.push('The settings it had saved were deleted at the same time.');
  }
  parts.push('Apex Agent now works only through your code editor.');

  dom.noticeBody.textContent = parts.join(' ');
  show(dom.notice, true);
}

async function dismissNotice() {
  const stored = await chrome.storage.local.get('apexNotices');
  const notices = stored.apexNotices && typeof stored.apexNotices === 'object' ? stored.apexNotices : {};
  notices[NOTICE_ID] = { dismissedAt: Date.now() };
  await chrome.storage.local.set({ apexNotices: notices });
  show(dom.notice, false);
  send('apex:dismissNotice', { id: NOTICE_ID });
}

/*
  Enforcement denies anything that is not explicitly true, so an install where the policy key was
  never written would refuse every request and show eight switches in the off position with no
  explanation. The service worker's migration seeds the defaults, but the popup is the only writer
  of this key and it costs one read to make the panel correct even if that migration was never
  wired up. Writes only when the key is genuinely absent, so a user who switched everything off
  does not find it switched back on.
*/
async function ensurePolicySeeded() {
  const stored = await chrome.storage.local.get(POLICY_KEY);
  if (stored[POLICY_KEY] && typeof stored[POLICY_KEY] === 'object') return;
  await chrome.storage.local.set({
    [POLICY_KEY]: normalisePolicy({ ...DEFAULT_POLICY, updatedAt: Date.now() })
  });
}

/* ---------- refresh cycle ---------- */

async function refresh() {
  const reply = await send('apex:getState');
  const state = reply && typeof reply === 'object' ? reply : { status: 'unavailable' };

  renderStatus(state);
  renderPairing(state);
  renderClients(state);

  /*
    Permission state is read from storage rather than trusted from the reply, because storage is
    what the worker enforces against. If the two ever disagree the switches must show the enforced
    value.
  */
  const stored = await chrome.storage.local.get(POLICY_KEY);
  renderPolicy(normalisePolicy(stored[POLICY_KEY]));

  const activity = await send('apex:getActivityLog', { limit: ACTIVITY_LIMIT });
  renderActivity(activity && Array.isArray(activity.entries) ? activity.entries : []);

  /*
    Setup instructions open themselves exactly when they are the next thing to do. Once connected
    they stay folded away, which is what keeps the healthy view inside one screen.
  */
  if (state.status === 'not_running' && !dom.setupBlock.dataset.userSet) {
    dom.setupBlock.open = true;
  }
}

/* ---------- wiring ---------- */

async function init() {
  grab(
    'buildVersion', 'notice', 'noticeBody', 'noticeDismiss',
    'statusBlock', 'stateWord', 'stateSay', 'stateExtra', 'stateTech', 'stateDetail',
    'reconnectBtn', 'openExtensionsBtn',
    'pairingBlock', 'pairCode', 'expiryFill', 'expiryText', 'approveBtn', 'rejectBtn', 'pairError',
    'clientList', 'clientCount', 'clientEmpty',
    'masterSwitch', 'masterSay', 'permBlock', 'permSummary', 'permList', 'pausedNote',
    'activityBlock', 'activitySummary', 'activityList', 'activityEmpty',
    'setupBlock', 'editorOptions', 'setupPath', 'setupNote', 'setupSnippet', 'copyBtn', 'copyStatus',
    'guideBtn'
  );

  dom.buildVersion.textContent = `v${chrome.runtime.getManifest().version}`;

  buildPermissionRows();
  dom.masterSwitch.addEventListener('change', () => setMaster(dom.masterSwitch.checked));

  dom.approveBtn.addEventListener('click', () => decidePairing(true));
  dom.rejectBtn.addEventListener('click', () => decidePairing(false));

  /* Optimistic wording only — the real state still comes from the worker on the next refresh. */
  dom.reconnectBtn.addEventListener('click', async () => {
    dom.reconnectBtn.disabled = true;
    setText(dom.stateSay, 'Trying to reach the server again.');
    await send('apex:reconnect');
    dom.reconnectBtn.disabled = false;
    await refresh();
  });

  dom.openExtensionsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
  });

  dom.noticeDismiss.addEventListener('click', dismissNotice);
  dom.copyBtn.addEventListener('click', copySnippet);
  dom.guideBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('getting-started.html') });
  });

  /* Remember that the user chose to fold a section, so refresh() stops reopening it at them. */
  for (const block of [dom.setupBlock, dom.permBlock, dom.activityBlock]) {
    block.addEventListener('toggle', () => {
      block.dataset.userSet = 'yes';
    });
  }

  const stored = await chrome.storage.local.get('apexSetupEditor');
  const chosen = findEditorTarget(stored.apexSetupEditor);
  buildEditorPicker(chosen.id);
  renderEditorTarget(chosen.id);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;

  await renderNotice();
  await ensurePolicySeeded();
  await refresh();

  /*
    Push and poll together. The push keeps the panel honest the instant a pairing frame arrives;
    the poll is the safety net for the case the worker was asleep when it should have pushed, which
    on MV3 is not a rare case.
  */
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'apex:stateChanged') refresh();
  });
  setInterval(refresh, REFRESH_MS);
}

init();
