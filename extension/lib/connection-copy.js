/*
  The connection states, in the words a user sees, in one place.

  Version 1 had exactly one state — "Not Connected" — covering a server that was never started, a
  pairing that was never approved, and a socket that had dropped. Those have three different fixes,
  so collapsing them meant the honest answer to "why isn't this working" was never on screen. Each
  state below therefore carries the fix, not just the label.

  The popup and the getting-started guide both import this, because a troubleshooting section that
  names states differently from the panel it is troubleshooting is worse than no troubleshooting
  section.
*/

export const CONNECTION_STATES = {
  checking: {
    word: 'Checking',
    say: 'Looking for the Apex Agent server on this computer.',
    fix: 'Give it a moment. If it stays here, reload the extension.'
  },
  not_running: {
    word: 'Not running',
    say: 'Nothing on this computer is listening yet. Open the editor you configured, or start the server yourself in a terminal:',
    command: 'npx -y apex-agent-mcp',
    fix: 'Your editor starts the server when it loads the Apex Agent entry from its MCP config. If the editor is open and this still says Not running, the config was not picked up — check the file path and restart the editor completely.',
    offerReconnect: true
  },
  pairing: {
    word: 'Waiting for approval',
    say: 'Something is asking to connect. Check the code below against your editor before you approve it.',
    fix: 'Open the extension panel, compare the six digits with the ones in your editor’s MCP log, and choose Approve. The code expires after two minutes; restarting the editor issues a new one.'
  },
  connected: {
    word: 'Connected',
    say: 'This browser is linked to the Apex Agent server.',
    fix: 'Nothing to do. If your assistant still cannot act, check the capability switches — a request for something switched off is refused, not silently dropped.'
  },
  reconnecting: {
    word: 'Reconnecting',
    say: 'The connection dropped and is being retried.',
    fix: 'Usually resolves itself within a few seconds. If it does not, the server process has probably exited: restart your editor.',
    offerReconnect: true
  },
  blocked: {
    word: 'Blocked',
    say: 'The server refused the connection.',
    fix: 'The panel explains which of the two causes applies: this browser was never approved, or the server and the extension are different versions. Both are fixed from outside the browser.',
    offerReconnect: true
  },
  unavailable: {
    word: 'Needs a reload',
    say: 'Apex Agent’s background process is not answering. Reload the extension, then open this panel again.',
    fix: 'Go to your extensions page and press reload on Apex Agent. If it keeps happening, the service worker is crashing — its console is on the same page, under “service worker”.',
    offerExtensionsPage: true
  }
};

/*
  Reasons a connection is refused, in the user's terms. Anything outside this table falls through to
  a sentence that points at the technical detail disclosure, because a bare identifier like
  NOT_PAIRED tells a person nothing and tells them so in a way that feels like a fault of theirs.
*/
export const BLOCKED_REASONS = {
  not_paired: 'This browser has not been approved yet. Restart your editor to get a new pairing code.',
  pairing_rejected: 'You rejected the last request to connect. Restart your editor to try again.',
  pairing_expired: 'The pairing code expired before it was approved. Restart your editor for a new one.',
  rate_limited: 'Too many wrong codes were tried, so this browser is refused for a minute. Then restart your editor.',
  version_mismatch: 'The server on this computer is a different version of Apex Agent than this extension. Update both to the same version.',
  permission: 'Chrome would not allow the connection to the local server. Check that no policy or firewall is blocking 127.0.0.1 port 3052.'
};

const UNKNOWN_BLOCK =
  'The server refused the connection, and did not say why in terms this panel can explain. The technical detail below is what it reported.';

/*
  Turn a state snapshot into finished sentences. An unrecognised status resolves to "unavailable"
  rather than being displayed raw: if the worker sends something this build has never heard of, the
  honest reading is that the two halves of the extension do not match.
*/
export function describeState(state) {
  const snapshot = state && typeof state === 'object' ? state : {};
  const key = Object.hasOwn(CONNECTION_STATES, snapshot.status) ? snapshot.status : 'unavailable';
  const base = CONNECTION_STATES[key];

  let say = base.say;
  if (key === 'connected' && snapshot.hubVersion) {
    say = `This browser is linked to the Apex Agent server (hub ${snapshot.hubVersion}).`;
  }
  if (key === 'reconnecting' && Number.isFinite(snapshot.attempt) && snapshot.attempt > 0) {
    say = `The connection dropped. Trying again — attempt ${snapshot.attempt}.`;
  }
  if (key === 'blocked') {
    say = BLOCKED_REASONS[snapshot.blockedReason] || UNKNOWN_BLOCK;
  }

  return {
    key,
    word: base.word,
    say,
    fix: base.fix,
    command: base.command || '',
    offerReconnect: Boolean(base.offerReconnect),
    offerExtensionsPage: Boolean(base.offerExtensionsPage)
  };
}
