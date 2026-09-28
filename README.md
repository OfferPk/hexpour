# HexPour

**Offline hex sort / pour puzzle PWA** — stack and pour colors across a soft hive until every cell is pure.

> **Not TubeSort.** No vertical water tubes. Mechanic = **hex cells with color stacks** + pour only to **adjacent** hexes.

| | |
|---|---|
| **Project ID** | `proj_hexpour_001` |
| **Slug** | `hexpour` |
| **Pages base** | `/hexpour/` |
| **Version** | 0.1.0 |
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
- Ads stubs: `showInterstitial`, `showRewarded`, `purchaseRemoveAds`, `isAdsRemoved`
- Screens: Home, level select, play, win; mute / settings
- Progress in `localStorage` (unlock + adsRemoved + mute)
- PWA offline after first load
- First-run howto + Home How to play; win Share; Home A2HS tip (Unreleased polish)

## Docs

- [GUIDE-roman-urdu.md](./GUIDE-roman-urdu.md) — Roman Urdu user guide
- [STATUS.md](./STATUS.md) — pipeline status
- [CHANGELOG.md](./CHANGELOG.md)

## Tests

```bash
npm test
```

Covers hex neighbors, legal/illegal pour, win detect, level-1 fixture, ads stubs.

## License

Proprietary factory build — original art/theme; no Hexa Sort / Hex Match IP.
