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

**Undo** is unlimited and becomes available after your first pour. **Restart** asks before discarding a board once you have made a pour. **Hint** includes one free use per level; the play-screen button shows when its free use is spent and the next hint opens the rewarded-ad stub.

The play screen shows the pour count. Keyboard and screen-reader users can expand **Keyboard and screen reader controls**, then use Tab and Enter/Space to select a source and destination; Escape deselects an armed source. Token letters and spoken color names supplement color alone.

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
npm run test:browser:blocked
npm run test:browser:level-select
npm run test:browser:selection-cancel
```

Covers hex neighbors, legal/illegal pours, win detection, ad stubs, descriptive cell labels, validation of all 40 level definitions and opening moves, and exact shortest-solution lengths for all 40 levels. `npm run audit:levels` prints the complete 1–40 depth profile; each level has a 2,000,000-state and 60-second bound, and a bounded search is reported as incomplete rather than unsolvable.

`npm run test:browser:viewport` starts a loopback-only Vite server and runs system Chromium headlessly using Node 22+’s built-in WebSocket API, without adding browser packages. It checks canvas resize/redraw at 320×568, 360×640, 390×844, 667×375, and 844×390. In the disposable browser profile, it also uses real Tab/Enter key events on Level 2 to select a source and destination, checks that Undo is natively disabled until a pour is made and disabled again after Undo or Restart, checks the Hint button’s free-to-rewarded state and reset on Restart, verifies Undo restores the board, and confirms Hint produces accessible feedback plus a visible canvas highlight. The fixture is under `tests/`, seeds only the throwaway Chromium profile, and is not included in the production build. Set `CHROMIUM_BIN` if Chromium is not at a detected system path. This is a local command; the repository has no configured CI workflow.

`npm run test:browser:blocked` uses its own empty temporary Chromium profile and loopback app origin to test Level 11’s blocked-hole-then-legal-destination path. It checks that blocked feedback preserves source selection, visual targets, focus, polite live-region status, and the saved board/settings; then it verifies a legal pour and Undo.

`npm run test:browser:level-select` uses a fresh disposable Chromium profile to test keyboard traversal of unlocked choices, Escape and Back focus restoration, and exact preservation of the active saved-run snapshot, undo history, unlocks, settings, and storage. Set `HEXPOUR_TEST_URL` to run the same test against the live site in a separate fresh profile.

`npm run test:browser:selection-cancel` uses a fresh disposable Chromium profile to test keyboard source selection, Escape-only deselection with focus preservation and byte-for-byte saved-state preservation, reselection, and a subsequent legal Level 2 pour. Set `HEXPOUR_TEST_URL` to run it against the live site in a separate fresh profile.

`npm run test:browser:first-play-focus` uses a new empty disposable Chromium profile to verify first-run How-to focus, modal Tab containment, Home tab order, keyboard dismissal and Start activation, focus visibility/transfer into board controls, and no unintended saved puzzle/settings/unlock state. It verifies the profile and browser storage are empty before any test interaction, removes the profile afterward, and checks DOM/accessibility attributes only; it does not test spoken output.

## License

Proprietary factory build — original art/theme; no Hexa Sort / Hex Match IP.
