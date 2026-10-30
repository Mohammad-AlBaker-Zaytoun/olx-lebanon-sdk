/** The confirmation window. It shows the asking website and sends the person's answer. */
import type { DecisionMessage } from '../../src/connect/protocol.js';

declare const chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };

const params = new URLSearchParams(location.hash.slice(1));
const requestId = params.get('id') ?? '';
const origin = params.get('origin') ?? '';
let host = origin;
try {
  host = new URL(origin).host;
} catch {
  /* show the raw value */
}

const $ = (id: string) => document.getElementById(id)!;
$('site').textContent = host || 'A website';
$('origin').textContent = origin;
document.title = `OLX Connect: ${host}`;

async function decide(allow: boolean): Promise<void> {
  for (const id of ['allow', 'deny']) ($(id) as HTMLButtonElement).disabled = true;
  const message: DecisionMessage = { type: 'olx-connect/decision', requestId, allow };
  const reply = (await chrome.runtime.sendMessage(message).catch(() => null)) as { ok?: boolean } | null;
  if (reply?.ok) return; // the extension closes this window
  const error = $('error');
  error.textContent = 'This request is no longer active. Close this window and try again from the website.';
  error.hidden = false;
}

$('allow').addEventListener('click', () => void decide(true));
$('deny').addEventListener('click', () => void decide(false));
