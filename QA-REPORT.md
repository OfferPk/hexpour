# QA Report — HexPour MVP v0.1.0

**Date:** 2026-09-28 18:25 PKT (Asia/Karachi)  
**Project:** `/workspace/factory/projects/hexpour`  
**Version:** 0.1.0  
**HEAD audited:** `754788616ea56933efaff1ef4581fe6b312decc4` (`7547886` — feat(hexpour): MVP 0.1.0 READY_FOR_QA) — **not amended**  
**PRD:** `/workspace/factory/research/PRD-hexpour.md`  
**BUILD:** `/workspace/factory/research/BUILD-hexpour.md`  
**STATUS claim:** `READY_FOR_QA`  
**QA:** Independent pass (report only — no product code changes; no GitHub push; no agent messages)  
**Overall:** **PASS**

---

## Summary

MVP scope holds against Master checklist + PRD §5 / §8. Flat-top axial hex pour (not tubes), **40** BFS-solvable JSON levels (capacity **3–4**), unlimited undo, hint (1 free → rewarded stub), ads stubs, Home / levels / play / win, `localStorage`, PWA `base: '/hexpour/'`, README + GUIDE-roman-urdu.md + STATUS + CHANGELOG 0.1.0. Automation: **`npm test` 17/17**, **`npm run build` green**. Extra solvability probe: **40/40** BFS-solvable. Preview smoke `http://127.0.0.1:4190/hexpour/` — shell/manifest/SW/assets/icons **200**. No P0/P1 ship blockers.

| Severity | Count |
|----------|------:|
| Critical / P0 | 0 |
| High / P1     | 0 |
| Medium / P2   | 0 |
| Low / P3 (residual) | 5 |

**CLEAR for publish from QA:** **YES** (host under `base: /hexpour/`).

---

## Environment

| Item | Detail |
|------|--------|
| Runtime | `npm run preview -- --host 127.0.0.1 --port 4188` → bound **4190** (4188/4189 busy) → `http://127.0.0.1:4190/hexpour/` |
| Methods | PRD/BUILD/STATUS/README/GUIDE/CHANGELOG; source review (`hex`, `engine`, `persist`, `ads/stubs`, `ui/app`, `render/hexBoard`, levels, PWA); vitest; production build; QA-only BFS solvability of 40 levels (temp probe, deleted; not committed); HTTP smoke of `dist/` |
| Zone | Asia/Karachi (UTC+5); times PKT |
| Git | Local `main` at `7547886`; SHA not amended; no push this QA |

---

## Automation

| Check | Result |
|-------|--------|
| `npm test` | **17/17 passed** — `tests/hex.test.ts` (3) + `tests/pour.test.ts` (11) + `tests/ads.test.ts` (3); vitest 3.2.7; exit 0 |
| `npm run build` | **green** — `tsc && vite build`; vite 6.4.3; PWA v1.3.0 `generateSW`; **11 precache entries** (46.79 KiB); `dist/sw.js` + `workbox-*.js`; asset hrefs under `/hexpour/`; exit 0 |
| Extra BFS solvability | **40/40** solvable (QA probe using `loadBoard` / `listLegalPours` / `tryPour` / `isWon`; max depth observed 9 on L10; hardest state expansions L17/L21) |

---

## Master scope verification

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Flat-top axial hex pour (**NOT tubes**) | **PASS** | `src/game/hex.ts`: documented FLAT-TOP axial; `axialToPixel` uses flat-top formulas; `hexCorners` angles `60*i` from 0°; `AXIAL_DIRS` 6 neighbors. Engine `tryPour` requires `areAdjacent`. Canvas stacks-in-hexes (`hexBoard.ts`). Home copy: “Not tubes — adjacent hexes only.” README differentiation table vs TubeSort. No tube UI in `src/`. |
| 2 | 40 BFS-solvable JSON levels, capacity 3–4 | **PASS** | `src/levels/level-01.json`…`level-40.json` + `LEVELS` length 40, ids 1–40 continuous. Capacities: **12×3 + 28×4** only. Colors `R\|G\|B\|Y\|P\|O`. QA BFS: **40/40 solvable**. Stacks never exceed capacity. |
| 3 | Unlimited undo; hint 1 free then rewarded stub | **PASS** | `doUndo` pops unlimited `undoStack` clones. `freeHintsLeft = 1` per `startLevel`; after free → `showRewarded('hint')` then `hintPour` highlight. |
| 4 | Ads stubs | **PASS** | `src/ads/stubs.ts`: `showInterstitial`, `showRewarded`, `purchaseRemoveAds`, `isAdsRemoved`. UI presenters (modal stubs); win/restart interstitial; Settings remove-ads. Ads tests 3/3. No AdMob SDK/keys in bundle. |
| 5 | Home / levels / play / win | **PASS** | `src/ui/app.ts` screens `'home' \| 'levels' \| 'play' \| 'win'`; Settings overlay (mute + remove-ads); win → Next / Levels / Home. |
| 6 | localStorage | **PASS** | Key `hexpour_v1`: `unlocked`, `adsRemoved`, `mute`. Sequential unlock via `unlockLevel` on win. |
| 7 | PWA base `/hexpour/` | **PASS** | `vite.config.ts` `base: '/hexpour/'`; `public/manifest.webmanifest` start_url/scope `/hexpour/`; SW registers `/hexpour/sw.js` scope `/hexpour/`; dist assets prefixed `/hexpour/`. |
| 8 | README + GUIDE-roman-urdu.md + STATUS + CHANGELOG 0.1.0 | **PASS** | All four present at project root. CHANGELOG `## 0.1.0 — 2026-09-28`. GUIDE Roman Urdu §§1–9. STATUS `READY_FOR_QA`. |

### Also verified

| Item | Verdict | Evidence |
|------|---------|----------|
| Win detect (MVP lock) | **PASS** | `isWon`: every occupied non-blocked cell is uniform color; empties OK; matches PRD §4 locked MVP win (not fill-to-capacity). Vitest covers win/not-won. |
| Pour rules | **PASS** | Adjacency, capacity, same-color top run, blocked, empty-source — unit tests + engine. |
| Offline after first load (structural) | **PASS** | SW `precacheAndRoute` + NavigationRoute → `index.html`; no gameplay network fetch required. No live airplane-mode toggle this pass. |
| Original theme / IP | **PASS** | Soft hive CSS/canvas palette; README/STATUS disclaim Hexa Sort / Hex Match / TubeSort. |
| No git push / SHA intact | **PASS** | HEAD remains `7547886`; report-only. |

---

## Preview smoke (HTTP)

Base: `http://127.0.0.1:4190/hexpour`

| URL | Result |
|-----|--------|
| `/` | **200** HTML — HexPour title, `#app`, assets under `/hexpour/` |
| `/manifest.webmanifest` | **200** — name HexPour, display standalone, scope `/hexpour/` |
| `/sw.js` | **200** — precache index/assets/icons/manifest |
| `/assets/index-*.js`, `*.css` | **200** |
| `/icons/icon-192.png`, `512.png`, `icon.svg` | **200** |

---

## PRD acceptance mapping (§8)

| Criterion | Result |
|-----------|--------|
| Pour only to adjacent hexes; capacity + same-color | **PASS** |
| 40 playable levels; sequential unlock | **PASS** (+ BFS 40/40) |
| Undo + hint; win detect | **PASS** |
| PWA offline; assets under `/hexpour/` | **PASS** (structural + smoke) |
| Ads/remove-ads stubs wired | **PASS** |
| `npm test` + `npm run build` | **PASS** |
| README + GUIDE; original hive; no tube UI | **PASS** |
| No live-ops / licensed clone branding | **PASS** |

---

## Residuals (non-blocking)

1. **P3 — Mute is preference-only:** Mute toggles persist to `localStorage` but MVP has no SFX/audio path that reads `mute`.  
2. **P3 — Resize listener accumulate:** `renderPlayShell` adds `window.addEventListener('resize', …)` each play entry without remove — minor leak across level transitions.  
3. **P3 — Late pack often shallow:** Several mid/late levels BFS-solve in depth 1–2 (nearly sorted boards). Still solvable; pack polish optional.  
4. **P3 — Color-count vs capacity heuristic:** PRD §6 mentions tokens-per-color divisible by capacity as a solvability heuristic. Levels **13–21** have counts like G=11 with cap=4 (not divisible). Valid under **locked MVP win** (uniform stacks, partial OK); all still BFS-solved.  
5. **P3 — No live offline-network toggle:** Airplane-mode browser check not performed; SW precache + NavigationRoute satisfy structural offline gate.

---

## Blockers

**None (P0/P1).**

---

## Verdict

| Question | Answer |
|----------|--------|
| Overall | **PASS** |
| CLEAR for publish from QA? | **YES** |

Report only — product sources untouched; SHA `7547886` not amended; no git push; no agent messages.
