# HexPour

**Offline hex sort / pour puzzle PWA** — stack and pour colors across a soft hive until every cell is pure.

> **Not TubeSort.** No vertical water tubes. Mechanic = **hex cells with color stacks** + pour only to **adjacent** hexes.

| | |
|---|---|
| **Project ID** | `proj_hexpour_001` |
| **Slug** | `hexpour` |
| **Pages base** | `/hexpour/` |
| **Version** | 0.1.1 |
| **Stack** | Vite + TypeScript + PWA |

## Play

```bash
npm install
npm run dev
```

Open the printed local URL. Production build:

```bash
npm test
npm run build
npm run preview
```

GitHub Pages path expects assets under `/hexpour/`.

## How to play

1. Tap a hex that has color tokens (top of stack is pourable).
2. Tap an **adjacent** hex to pour the top same-color run onto it.
3. Target must be empty or share the same top color, and have free capacity (3–4).
4. **Win:** every occupied cell’s stack is a single color. Empty cells are OK. Blocked (hole) cells never hold tokens.

**Undo** is unlimited. **Hint** — 1 free per level, then a rewarded-ad stub.

The play screen shows the pour count. Keyboard and screen-reader users can expand **Keyboard and screen reader controls**, then use Tab and Enter/Space to select a source and destination. Token letters and spoken color names supplement color alone.

## Differentiation

| HexPour | TubeSort-class |
|---------|----------------|
| Hex grid, 6-neighbor pour | Vertical tubes |
| Soft hive / geometric art | Tube UI |
| Stacks inside hex cells | Liquid columns |

Orientation: **flat-top** axial coordinates (documented in `src/game/hex.ts`).

## Features (MVP)

- 40 JSON levels (easy → hard), colors `R|G|B|Y|P|O`
- Unlimited undo + hint
- Demo ad hooks; the rewarded-hint prompt remains a stub, while wins and restarts are uninterrupted
- Screens: Home, level select, play, win; mute / settings
- Progress in `localStorage` (unlock + adsRemoved + mute)
- PWA offline after first load
- First-run howto + Home How to play; win Share; Home A2HS tip
- Keyboard/screen-reader cell controls, descriptive token labels, and reduced-motion support

## Docs

- [GUIDE-roman-urdu.md](./GUIDE-roman-urdu.md) — Roman Urdu user guide
- [STATUS.md](./STATUS.md) — pipeline status
- [CHANGELOG.md](./CHANGELOG.md)

## Tests

```bash
npm test
npm run audit:levels
npm run test:browser:viewport
```

Covers hex neighbors, legal/illegal pours, win detection, ad stubs, descriptive cell labels, validation of all 40 level definitions and opening moves, and exact shortest-solution lengths for all 40 levels. `npm run audit:levels` prints the complete 1–40 depth profile; each level has a 2,000,000-state and 60-second bound, and a bounded search is reported as incomplete rather than unsolvable.

`npm run test:browser:viewport` starts a loopback-only Vite server and runs system Chromium headlessly using Node 22+’s built-in WebSocket API, without adding browser packages. It opens the game at 667×375, suppresses the animation loop, toggles the keyboard/screen-reader cell panel, and checks that the canvas backing store resizes and the board is redrawn after both changes. Set `CHROMIUM_BIN` if Chromium is not at a detected system path. This is a local command; the repository has no configured CI workflow.

## License

Proprietary factory build — original art/theme; no Hexa Sort / Hex Match IP.
