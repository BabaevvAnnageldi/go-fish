# 🐟 Go Fish — Online for Two

A browser-based Go Fish card game for two people on different devices. You don't need to sign up or install anything, and there's no server: the two browsers connect directly to each other over WebRTC.

**Play:** https://babaevvannageldi.github.io/go-fish/

## How to start a game
1. Player 1 opens the site, enters a name, and taps **Create game**. A 4-letter room code appears.
2. Player 1 taps **Copy invite link** and sends it to Player 2. Player 2 can also open the site and type the code.
3. Player 2 enters a name and taps **Join game**. The cards are dealt automatically.

If someone refreshes or briefly loses connection, the game resumes. The host's browser keeps the game state, so the host should keep their tab open.

## Rules
These are the official [Bicycle Cards](https://bicyclecards.com/how-to-play/go-fish) rules for two players:

- **Deal:** each player gets 7 cards. The rest form the **pond**.
- **Asking:** on your turn, ask your opponent for a rank you already hold.
  - If they have it, they give you **all** their cards of that rank and you **go again**.
  - If they don't, it's **"Go fish!"** You draw a card and your turn ends.
- **Books:** four of a kind make a **book**, which is laid down automatically. Completing a book lets you play again.
- **Empty hand:** if your hand is empty, you draw from the pond automatically.
- **Winning:** when all 13 books are made, the player with the most books wins.
- **Optional house rule, "Fish your wish":** if you draw the rank you asked for, you show it and go again.

## Architecture
```
index.html        single page (lobby, waiting room, table, dialogs)
styles.css        responsive, light/dark felt-table theme
src/engine.js     pure deterministic rules engine (seeded RNG, immutable updates, redacted views)
src/net.js        PeerJS host/guest sessions (host-authoritative, reconnect)
src/seat.js       guest-seat policy (only the first guest's clientId may retake the seat)
src/ui.js         DOM rendering (textContent only, so names can't inject HTML)
src/main.js       app controller: lobby, host/guest flows, persistence, rematch
tests/            node:test suites (rules, 5k-game simulations, networking with a fake peer, static checks)
docs/PROMPT.md    the full build spec
.claude/agents/   the debugger and tester agents used to verify this project
```

**Networking:**
- The game creator is the **host**. Their browser holds the full game state, checks every move against the engine, and sends each player only what they're allowed to see.
- Your opponent's cards and the order of the pond never leave the host.
- The PeerJS public broker only helps the two browsers find each other. After that, game data flows peer-to-peer.

## Development
```bash
npm test        # node --test tests/*.test.js  (no dependencies)
npm start       # serve on http://localhost:8080
```

To test locally, open two browser windows: create a game in one and join from the other.

## Known limitation
WebRTC connects most networks through STUN alone. Some strict corporate or mobile-carrier NATs need a TURN relay, which this free setup doesn't include. If you can't connect, try a different Wi-Fi network or a phone hotspot.
