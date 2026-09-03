/*
  The guide's only moving parts: the editor picker, the copy button, a live connection check, and a
  troubleshooting list built from the same state copy the popup renders. Generating that list rather
  than writing it out in the HTML is deliberate — a troubleshooting section that names states
  differently from the panel it troubleshoots sends people looking for a status they will never see.
*/

import { EDITOR_TARGETS, findEditorTarget } from './lib/editor-setup.js';
import { CONNECTION_STATES, describeState } from './lib/connection-copy.js';

const dom = {
  editorOptions: document.getElementById('editorOptions'),
  setupPath: document.getElementById('setupPath'),
  setupNote: document.getElementById('setupNote'),
  setupSnippet: document.getElementById('setupSnippet'),
  copyBtn: document.getElementById('copyBtn'),
  copyStatus: document.getElementById('copyStatus'),
  checkBlock: document.getElementById('checkBlock'),
  checkWord: document.getElementById('checkWord'),
  checkSay: document.getElementById('checkSay'),
  checkCommand: document.getElementById('checkCommand'),
  checkBtn: document.getElementById('checkBtn'),
  troubleList: document.getElementById('troubleList')
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function buildPicker(selectedId) {
  for (const target of EDITOR_TARGETS) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'editor';
    input.id = `editor-${target.id}`;
    input.value = target.id;
    input.checked = target.id === selectedId;
    input.addEventListener('change', () => {
      renderTarget(target.id);
      chrome.storage.local.set({ apexSetupEditor: target.id });
    });

    const label = el('label', null, target.label);
    label.htmlFor = input.id;
    dom.editorOptions.append(input, label);
  }
}

function renderTarget(id) {
  const target = findEditorTarget(id);
  dom.setupPath.textContent = target.path;
  dom.setupNote.textContent = target.note;
  dom.setupSnippet.textContent = target.snippet;
  dom.setupSnippet.setAttribute('aria-label', `${target.label} configuration, ${target.language}`);
  dom.copyStatus.textContent = '';
}

async function copySnippet() {
  try {
    await navigator.clipboard.writeText(dom.setupSnippet.textContent);
    dom.copyStatus.textContent = 'Copied';
  } catch {
    dom.copyStatus.textContent = 'Could not copy — select the text and press Ctrl+C';
  }
  setTimeout(() => {
    dom.copyStatus.textContent = '';
  }, 2500);
}

/*
  The live check asks the service worker the same question the popup asks. It is here because
  "did step 4 work" is a question a person wants answered on the page they are following, not in
  another window they have to go and open.
*/
async function runCheck() {
  dom.checkBtn.disabled = true;
  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'apex:getState' });
  } catch (error) {
    console.warn('[apex] guide could not reach the service worker', error);
  }
  const view = describeState(reply || { status: 'unavailable' });
  dom.checkBlock.dataset.state = view.key;
  dom.checkWord.textContent = view.word;
  dom.checkSay.textContent = view.say;
  /*
    Some states end their sentence on a command the person is meant to run. It lives in its own
    monospaced line rather than inside the prose because the whole point of that string is that it
    gets copied character for character.
  */
  dom.checkCommand.textContent = view.command;
  dom.checkCommand.hidden = !view.command;
  dom.checkBtn.disabled = false;
}

function buildTroubleshooting() {
  for (const [key, state] of Object.entries(CONNECTION_STATES)) {
    if (key === 'checking') continue;
    const item = el('div', 'trouble-item');
    item.dataset.state = key;
    item.append(el('p', 'trouble-word', state.word));
    item.append(el('p', 'trouble-say', state.say));
    if (state.command) item.append(el('pre', null, state.command));
    item.append(el('p', 'trouble-fix', state.fix));
    dom.troubleList.append(item);
  }
}

async function init() {
  const stored = await chrome.storage.local.get('apexSetupEditor');
  const chosen = findEditorTarget(stored.apexSetupEditor);
  buildPicker(chosen.id);
  renderTarget(chosen.id);

  dom.copyBtn.addEventListener('click', copySnippet);
  dom.checkBtn.addEventListener('click', runCheck);

  buildTroubleshooting();
  await runCheck();
}

init();
