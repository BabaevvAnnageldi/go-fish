// DOM rendering. Everything user-provided is set via textContent (never innerHTML).

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_WORD = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };
const FACE_GLYPH = { J: '♞', Q: '♛', K: '♚' };

// Pip positions [x%, y%] matching a real deck; pips below the middle are drawn upside down.
const L = 36, C = 50, R = 64;
const PIP_LAYOUT = {
  2: [[C, 20], [C, 80]],
  3: [[C, 20], [C, 50], [C, 80]],
  4: [[L, 20], [R, 20], [L, 80], [R, 80]],
  5: [[L, 20], [R, 20], [C, 50], [L, 80], [R, 80]],
  6: [[L, 20], [R, 20], [L, 50], [R, 50], [L, 80], [R, 80]],
  7: [[L, 20], [R, 20], [C, 35], [L, 50], [R, 50], [L, 80], [R, 80]],
  8: [[L, 20], [R, 20], [C, 35], [L, 50], [R, 50], [C, 65], [L, 80], [R, 80]],
  9: [[L, 20], [R, 20], [L, 40], [R, 40], [C, 50], [L, 60], [R, 60], [L, 80], [R, 80]],
  10: [[L, 20], [R, 20], [C, 30], [L, 40], [R, 40], [L, 60], [R, 60], [C, 70], [L, 80], [R, 80]],
};

export const $ = (id) => document.getElementById(id);

export function rankName(rank, plural = true) {
  const w = RANK_WORD[rank] ?? rank;
  return plural ? `${w}s` : w;
}

export function cardName(card) {
  const r = card.slice(0, -1);
  return `${RANK_WORD[r] ?? r}${SUIT_SYMBOL[card.slice(-1)]}`;
}

// Human-readable log line for an engine log entry, from the viewer's perspective.
export function describeEntry(e, view) {
  const you = view.you;
  const isMe = e.player === you;
  const who = isMe ? 'You' : view.names[e.player];
  const opp = view.names[1 - you];
  switch (e.kind) {
    case 'start': return `${who} ${isMe ? 'go' : 'goes'} first`;
    case 'ask':
      if (e.got > 0) {
        return isMe
          ? `You asked for ${rankName(e.rank)} and got ${e.got}!`
          : `${opp} asked for ${rankName(e.rank)} — you gave ${e.got}`;
      }
      return isMe ? `You asked for ${rankName(e.rank)} — Go fish!` : `${opp} asked for ${rankName(e.rank)} — Go fish!`;
    case 'fish':
      if (isMe) return `You drew ${cardName(e.card)}${e.wish ? ' — fish your wish, go again!' : ''}`;
      return e.wish ? `${opp} fished their wish (${cardName(e.card)}) and goes again` : `${opp} drew from the pond`;
    case 'fish-empty': return 'The pond is empty';
    case 'book': return `${who} made a book of ${rankName(e.rank)}!`;
    case 'refill': return isMe ? `Your hand was empty — you drew ${cardName(e.card)}` : `${opp}'s hand was empty — they drew a card`;
    case 'out': return `${who} ${isMe ? 'have' : 'has'} no cards left`;
    case 'turn': return isMe ? 'Your turn' : `${opp}'s turn`;
    case 'over': return e.player == null ? "It's a tie!" : `${e.player === you ? 'You win' : `${opp} wins`}!`;
    default: return '';
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function cardEl(card, arrive) {
  const r = card.slice(0, -1);
  const s = card.slice(-1);
  const red = s === 'H' || s === 'D';
  const n = el('div', `card${red ? ' red' : ''}${arrive ? ' arrive' : ''}`);
  n.setAttribute('aria-label', cardName(card));
  const corner = (cls) => {
    const c = el('span', cls, r);
    c.append(el('small', null, SUIT_SYMBOL[s]));
    return c;
  };
  const face = el('span', 'face');
  face.setAttribute('aria-hidden', 'true');
  if (r === 'A') {
    face.append(el('span', 'pip-ace', SUIT_SYMBOL[s]));
  } else if (FACE_GLYPH[r]) {
    const frame = el('span', 'court', FACE_GLYPH[r]);
    frame.append(el('small', null, SUIT_SYMBOL[s]));
    face.append(frame);
  } else {
    for (const [x, y] of PIP_LAYOUT[r]) {
      const p = el('span', `pip${y > 50 ? ' flip' : ''}`, SUIT_SYMBOL[s]);
      p.style.left = `${x}%`;
      p.style.top = `${y}%`;
      face.append(p);
    }
  }
  n.append(corner('corner'), face, corner('corner br'));
  return n;
}

let prevHand = new Set();
let toastTimer = null;

export function showScreen(name) {
  for (const id of ['lobby', 'waiting', 'table']) $(id).hidden = id !== name;
  $('leaveBtn').hidden = name === 'lobby';
}

export function showToast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

export function setStatus(text, tone) {
  const s = $('status');
  s.hidden = !text;
  s.textContent = text ?? '';
  s.className = `status ${tone ?? ''}`;
}

export function resetHandMemory() {
  prevHand = new Set();
}

export function renderTable(view, { selected, onSelect }) {
  const me = view.you;
  const opp = 1 - me;
  const myTurn = view.phase === 'playing' && view.turn === me;

  $('oppName').textContent = view.names[opp];
  $('oppCount').textContent = `${view.oppCount} card${view.oppCount === 1 ? '' : 's'}`;
  $('myName').textContent = `${view.names[me]} (you)`;
  $('score').textContent = `${view.books[0].length} book${view.books[0].length === 1 ? '' : 's'}`;
  $('stockCount').textContent = view.stockCount;
  document.querySelector('.pond-card').style.visibility = view.stockCount ? 'visible' : 'hidden';

  const oppHand = $('oppHand');
  oppHand.replaceChildren(...Array.from({ length: view.oppCount }, () => el('div', 'card back')));

  for (const [id, books] of [['myBooks', view.books[0]], ['oppBooks', view.books[1]]]) {
    $(id).replaceChildren(...books.map((r) => el('span', 'book', r)));
  }

  const turn = $('turnText');
  turn.className = `turn-text${myTurn ? ' mine' : ''}`;
  turn.textContent = view.phase === 'over' ? 'Game over'
    : myTurn ? 'Your turn' : `${view.names[opp]} is thinking…`;

  const lines = view.log.filter((e) => e.kind !== 'turn').slice(-12).reverse();
  $('log').replaceChildren(...lines.map((e) => el('li', null, describeEntry(e, view))));

  // Hand, grouped by rank.
  const groups = new Map();
  for (const c of view.hand) {
    const r = c.slice(0, -1);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  }
  const legal = new Set(view.legal);
  const hand = $('myHand');
  hand.replaceChildren(...[...groups].map(([rank, cards]) => {
    const canAsk = legal.has(rank);
    const b = el('button', `group${canAsk ? ' legal' : ''}${selected === rank ? ' selected' : ''}${myTurn ? '' : ' dim'}`);
    b.type = 'button';
    b.disabled = !canAsk;
    b.setAttribute('aria-pressed', String(selected === rank));
    b.setAttribute('aria-label', `${cards.length} × ${rankName(rank, cards.length !== 1)}`);
    b.append(...cards.map((c) => cardEl(c, prevHand.size > 0 && !prevHand.has(c))));
    b.addEventListener('click', () => onSelect(rank));
    return b;
  }));
  prevHand = new Set(view.hand);

  const ask = $('askBtn');
  const validSel = myTurn && selected && legal.has(selected);
  ask.disabled = !validSel;
  ask.textContent = validSel ? `Ask for ${rankName(selected)}` : 'Ask';
  $('hint').textContent = !myTurn ? '' : validSel
    ? `Ask ${view.names[opp]} for ${rankName(selected)}?` : 'Tap a card to choose a rank';

  // End of game.
  const over = view.phase === 'over';
  $('overlay').hidden = !over;
  if (over) {
    const [mine, theirs] = [view.books[0].length, view.books[1].length];
    $('overTitle').textContent = view.winner == null ? "It's a tie!" : view.winner === me ? '🎉 You win!' : `${view.names[opp]} wins!`;
    $('overScore').textContent = `${mine} – ${theirs} books`;
  }
}
