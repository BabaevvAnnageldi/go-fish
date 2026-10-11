// In-game chat. The host keeps the authoritative history (so it survives refreshes/reconnects)
// and relays each message. Text is always rendered with textContent.

import { $ } from './ui.js';

export const CHAT_LIMIT = 100;
export const MAX_LEN = 300;
export const QUICK = ['👍', '😂', '😍', '😮', '🔥', '😭', 'Go fish! 🐟', 'Good game!'];

// Normalize user text: string only, no control chars, collapsed spaces, max MAX_LEN characters (emoji-safe).
export function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, MAX_LEN).join('');
}

export function isValidMessage(m) {
  return Boolean(m) && typeof m === 'object' && Number.isInteger(m.id) && (m.from === 0 || m.from === 1)
    && typeof m.text === 'string' && m.text.length > 0 && Array.from(m.text).length <= MAX_LEN && Number.isFinite(m.ts);
}

export function makeMessage(list, from, text, ts = Date.now()) {
  return { id: (list.at(-1)?.id ?? 0) + 1, from, text, ts };
}

export function appendMessage(list, msg) {
  const next = [...list, msg];
  return next.length > CHAT_LIMIT ? next.slice(-CHAT_LIMIT) : next;
}

const emojiOnly = (s) => /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]{1,16}$/u.test(s);

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function renderChat(list, { you, names }) {
  const ol = $('chatList');
  if (!list.length) {
    ol.replaceChildren(node('li', 'chat-empty', `Say hi to ${names[1 - you]} 👋`));
    return;
  }
  ol.replaceChildren(...list.map((m) => {
    const mine = m.from === you;
    const li = node('li', `msg${mine ? ' mine' : ''}${emojiOnly(m.text) ? ' big' : ''}`);
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.append(node('span', 'who', mine ? 'You' : names[m.from]), node('p', null, m.text), node('time', null, time));
    return li;
  }));
  ol.scrollTop = ol.scrollHeight;
}

export function renderQuick(onPick) {
  $('chatQuick').replaceChildren(...QUICK.map((q) => {
    const b = node('button', 'quick', q);
    b.type = 'button';
    b.addEventListener('click', () => onPick(q));
    return b;
  }));
}
