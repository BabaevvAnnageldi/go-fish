# Build Prompt — "Go Fish" Online (2 Players)

## Role
You are a senior front-end engineer and game developer. Build a polished, production-quality, **two-player online Go Fish card game** that two people on different devices and networks can play against each other in real time from a browser, with no install and no paid server.

## Goals
1. Faithful implementation of the official Go Fish rules (below).
2. Real-time online play between exactly two players using a short room code.
3. Delightful, mobile-friendly UI that works on a phone (≈375px wide) and on desktop.
4. Deterministic, fully unit-tested game engine separated from UI and networking.
5. Zero-cost hosting on GitHub Pages (static files only).

## Official Rules (source: Bicycle Cards — bicyclecards.com/how-to-play/go-fish)
- **Deck:** standard 52 cards, 13 ranks (A, 2–10, J, Q, K) × 4 suits. Shuffle uniformly (Fisher–Yates).
- **Deal:** with 2 players, each player gets **7 cards**. The rest form the face-down **stock** ("the pond").
- **Books:** four cards of the same rank form a book. Whenever a player holds all four of a rank (including right after the deal), the book is immediately laid down face-up and scored.
- **Turn:** the active player asks the opponent for a **rank**. They **must already hold at least one card of that rank**.
  - If the opponent has any cards of that rank, they must hand over **all** of them. The asker **goes again**.
  - Otherwise the opponent says **"Go fish!"** and the asker draws the top card of the stock. The turn passes to the opponent.
  - **Optional house rule, "Fish your wish"** (toggle in the lobby, off by default): if the drawn card is the asked rank, the asker reveals it and goes again.
  - Completing a book with a draw also lets the player go again (official rule: "places them on the table … and plays again").
- **Empty hand:** if a player has no cards at the start of their turn (or during it), they draw one card from the stock and continue. If the stock is empty too, they are out of play and the turn passes.
- **Empty stock:** a "Go fish" with an empty stock simply passes the turn.
- **End:** the game ends when all **13 books** are made. The player with the **most books wins**. (With 13 books there can't be a tie.)

## Architecture
- **Stack:** plain HTML + CSS + vanilla JavaScript ES modules. No build step, no framework.
- **Files:**
  - `index.html` is the single page.
  - `src/engine.js` holds the pure game engine: no DOM, no network, no randomness except through an injected RNG. It exports `createGame(opts)`, `applyAction(state, action)` (returns a new state, never mutates), `viewFor(state, playerIndex)` (the redacted view), `legalRanks(state, p)`, plus constants.
  - `src/net.js` handles PeerJS networking: host/guest connection, message protocol, reconnect.
  - `src/ui.js` handles rendering and input.
  - `src/main.js` wires everything together.
  - `styles.css` holds the styles.
  - `tests/*.test.js` contains Node built-in test runner (`node --test`) tests. No dependencies.
- **Networking model:** host-authoritative.
  - The host creates a room with a random 4-letter code. The PeerJS peer id is `gofish-v1-<code>`, using the free PeerJS cloud broker and Google STUN.
  - The guest joins with the code.
  - The host owns the full state, validates every guest action with the engine, then sends each player **only their redacted view**. The opponent's hand is sent as a count and never as card identities, and the stock is sent as a count.
  - Messages are JSON:
    - Guest → host: `{type:'hello',name,clientId}` (sent on every (re)connect; `clientId` is a per-browser id), `{type:'action',rank}` (ask for a rank), `{type:'rematch'}`.
    - Host → guest: `{type:'view',view}`, `{type:'error',message}`, `{type:'full'}` (the seat belongs to another client; the guest returns to the lobby), `{type:'bye'}` (the host left; the guest stops retrying and shows "Opponent left").
  - Seating: the first guest's `clientId` owns the seat for that room. Only that same `clientId` may retake it after a disconnect; anyone else gets `full`.
- **Resilience:** if the guest disconnects, the host keeps the state and the guest can rejoin with the same code. The host persists the game state in `localStorage` so a host refresh resumes the game. Wrap all storage in try/catch.
- **Security/cheating:** the guest never receives hidden information. The engine rejects illegal actions (wrong turn, asking for a rank you don't hold, malformed input).

## UX Requirements
- **Lobby:** a name input, a "Create game" button that shows the code big with a copy-link button, and a "Join game" field with the code. Support a `?room=CODE` URL that auto-fills the code.
- **Table:**
  - Opponent area at the top: name, card backs fanned by count, books.
  - Stock in the middle with its count.
  - Your hand at the bottom: cards grouped and sorted by rank, large tap targets.
  - Your books, and a turn indicator ("Your turn" / "Waiting for <name>…").
- **Asking:** tap a card in your hand to select its rank, then press "Ask for 7s". Only legal ranks are tappable on your turn.
- **Feedback:** a message log/ticker ("Anna asked for Kings — got 2!", "Go fish!", "Book of 7s!"), plus a subtle animation when cards move and a toast for books.
- **End screen:** winner, book counts, and a "Play again" (rematch) button that keeps the connection.
- **Accessibility:** semantic buttons, visible focus, `aria-live` region for the log, and color plus a symbol for suits (red ♥♦, black ♠♣). The page must respect `prefers-color-scheme`.
- **Connection status:** show an indicator (connected / reconnecting / opponent left).

## Quality Bar
- The engine is 100% deterministic given a seeded RNG, and has tests for every rule above, every edge case, and full random-playout simulations (thousands of games) asserting these invariants:
  - There are 52 cards total at all times.
  - No duplicate cards exist.
  - Books are always complete.
  - The game always terminates with 13 books.
- No console errors. Works in current Chrome, Safari (iOS), and Firefox.
- The README covers how to play, how to host/join, rules, how to run tests, and the architecture.

## Agents
- **Debugger agent** (`.claude/agents/debugger.md`) reads the code, reproduces problems, finds root causes, and fixes them minimally.
- **Tester agent** (`.claude/agents/tester.md`) writes and runs tests (engine unit tests, simulations, protocol/redaction tests, and an end-to-end two-browser check where possible) and reports pass/fail with evidence.

## Deliverable
A GitHub repository with the code, tests, README, and agents, deployed on GitHub Pages so the game is playable at `https://<user>.github.io/go-fish/`.
