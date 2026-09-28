# QA Report — HexPour Unreleased polish post-v0.1.0 (IMPROVE-1834)

**Date:** 2026-09-28 18:42 PKT (Asia/Karachi)  
**Project:** `/workspace/factory/projects/hexpour`  
**Version:** 0.1.0 (SHIPPED) + Unreleased polish  
**HEAD verified:** `c3841cc62084d492d1cf1e9385d5e79a37d9b1eb` (`c3841cc` — `feat(hexpour): howto, win share, home A2HS (Unreleased)`)  
**Parent:** `7b67f08` (chore prepare v0.1.0 release) — **not amended**  
**Tag `v0.1.0`:** `7b67f084a62afc577b00bc60de702b87c4fd6e78` — **not amended**  
**Prior MVP QA:** `QA-REPORT.md` **PASS** @ `7547886` (full 40-level MVP — **not re-tested** this pass)  
**Inbox IMPROVE:** `/workspace/factory/inbox/IMPROVE-hexpour-20260928-1834.md`  
**QA:** Independent report only — no product source changes; no GitHub push; no agent messages; SHA **c3841cc** not amended  
**Overall:** **PASS**

---

## Summary

Unreleased polish at `c3841cc` delivers all three Master IMPROVE-1834 items on top of shipped v0.1.0: (1) first-run howto once + Home **How to play**, (2) win **Share** (`navigator.share` else clipboard + toast), (3) Home soft A2HS tip (session dismiss). Gates: **`npm test` 17/17** (claim verified), **`npm run build` green**. `base: '/hexpour/'` unchanged. No level-pack / TubeSort / AdMob / mute→SFX / daily-challenge work in scope. Preview smoke `http://127.0.0.1:4194/hexpour/` — shell/manifest/SW/icons **200**. Interactive Chrome headless smoke covered howto / A2HS / L1 win Share. **0 new P0 / 0 new P1.**

| Severity | Count |
|----------|------:|
| Critical / P0 | 0 |
| High / P1     | 0 |
| Medium / P2   | 0 |
| Low / P3 (new + carried) | 2 new cosmetic + 5 prior MVP residuals |

**CLEAR for publish from QA (Unreleased IMPROVE-1834):** **YES**

---

## Environment

| Item | Detail |
|------|--------|
| Runtime | `npm run preview -- --host 127.0.0.1 --port 4192` → bound **4194** → `http://127.0.0.1:4194/hexpour/` |
| Methods | IMPROVE ticket + STATUS/CHANGELOG/README/GUIDE; source review (`app.ts`, `persist.ts`, `style.css`); commit `c3841cc` vs `7b67f08`; vitest; production build; HTTP smoke; Chrome headless (puppeteer-core + `/usr/bin/google-chrome`) interactive flows |
| Zone | Asia/Karachi (UTC+5); times PKT |
| Git | Local `main` at `c3841cc` (ahead of origin by 1); stacked on `7b67f08`; tag `v0.1.0` untouched; no push this QA |

**Workspace note (not introduced by `c3841cc`):** dirty unstaged edits to `src/levels/level-18.json` + `level-27.json` and untracked `SECURITY-REPORT-IMPROVE-1839.md` observed at QA time. QA did **not** modify or stage them. Commit file list for `c3841cc` is docs + `persist.ts` + `style.css` + `app.ts` only.

---

## Automation

| Check | Result |
|-------|--------|
| `npm test` | **17/17 passed** — `tests/hex.test.ts` (3) + `tests/pour.test.ts` (11) + `tests/ads.test.ts` (3); vitest 3.2.7; exit 0. Claim **17/17 verified** (no new polish-specific unit file; count unchanged from MVP). |
| `npm run build` | **green** — `tsc && vite build`; vite 6.4.3; PWA v1.3.0 `generateSW`; **11** precache entries (~50.09 KiB); `dist/sw.js` + workbox; asset hrefs under `/hexpour/`; exit 0 |

---

## Master IMPROVE verification (1834)

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | First-run howto once + Home **How to play** | **PASS** | `persist.ts`: `HOWTO_KEY = 'hexpour:howto'`; `isHowtoSeen()` / `markHowtoSeen()` (`'1'`), separate from `hexpour_v1` blob. Boot: `setScreen('home')` then `if (!isHowtoSeen()) openHowto(true)`. Overlay: 6 EN bullets (adjacent pour, same top / empty, capacity 3–4, win = pure occupied stacks, Undo unlimited, Hint 1 free then stub) + Roman Urdu `Sirf padosi hex par pour — tubes nahi, hive hai.` + **Got it** → `markHowtoSeen()` + Home. Home **How to play** (`btn ghost`) reopens `openHowto(false)`. Subsequent load with `hexpour:howto=1` skips auto overlay. Play remains on Home after dismiss (not blocked). Chrome: first-run auto, persist, reopen, skip-on-reload all **PASS**. Dist retains `hexpour:howto` + howto copy. |
| 2 | Win Share — `navigator.share` else clipboard + toast | **PASS** | `renderWin` prepends **Share** (`btn gold`) → `shareWin()`. Text: `HexPour — hive clear! Level ${levelId}` + optional ` · unlocked through ${persist.unlocked}` when `unlocked > 1`. If `navigator.share` → `{ title: 'HexPour', text }` with `.catch` → `copyShare`; else `copyShare`. `copyShare`: `clipboard.writeText` → toast **Copied**; fail/missing → `legacyCopy` (`execCommand`) + same toast. Offline-only (no share URL / network). Chrome L1 clear: Share present; clipboard path toast **Copied** + clip `HexPour — hive clear! Level 1 · unlocked through 2`; stubbed `navigator.share` receives matching `{ title, text }`. Dist retains `navigator.share`, `hive clear`, `Copied`. |
| 3 | Home A2HS tip (session dismiss) | **PASS** | Home-only tip after `renderHome`: EN **Add to Home Screen** + Roman Urdu `Home screen par add karein — offline khelein.`; **Got it** → `sessionStorage['hexpour:a2hs']='1'` + remove tip. Hidden when dismissed or `matchMedia('(display-mode: standalone)')`. No `beforeinstallprompt` listener (comment-only mention). Not rendered into levels/play/win. Howto-first then Home+A2HS after Got it (re-`renderHome` / `setScreen('home')`). Chrome: tip after howto dismiss; session dismiss; absent on Levels; stays dismissed across reload; returns after `sessionStorage` clear. Dist retains `hexpour:a2hs` + tip copy. |

### Guardrails (also verified)

| Item | Verdict | Evidence |
|------|---------|----------|
| `base: '/hexpour/'` unchanged | **PASS** | `vite.config.ts`; preview HTML/assets under `/hexpour/`; manifest/SW **200** |
| Do not amend `v0.1.0` / SHA `c3841cc` | **PASS** | Tag still `7b67f08`; HEAD `c3841cc` parent `7b67f08`; QA made no git rewrite |
| Out of scope not rebuilt | **PASS** | Commit touches polish + docs + `persist` howto/clamp only; no TubeSort UI, no real AdMob, no daily challenge, no mute→SFX, no new level generator in commit |
| Full 40-level MVP not re-tested | **PASS** | Prior `QA-REPORT.md` PASS; this pass scoped to IMPROVE delta + automation |
| CHANGELOG Unreleased | **PASS** | Lists howto / Share / A2HS under `## Unreleased` |
| GUIDE / README / STATUS | **PASS** | GUIDE §§ How to play + A2HS + Share; README Unreleased polish line; STATUS READY_FOR_QA + polish checklist |

---

## Preview smoke (HTTP)

Base: `http://127.0.0.1:4194/hexpour`

| URL | Result |
|-----|--------|
| `/` | **200** — HexPour shell, `#app`, assets under `/hexpour/` |
| `/manifest.webmanifest` | **200** |
| `/sw.js` | **200** |
| `/icons/icon-192.png` | **200** |

---

## Findings

### P0 / P1 (ship blockers)

None.

### New residuals (non-blocking)

| ID | Severity | Title | Notes |
|----|----------|-------|-------|
| **HP-I1834-001** | **Low** | A2HS node present under first-run howto overlay | Boot `setScreen('home')` renders A2HS into `#home` before `openHowto(true)`. Overlay visually covers it; after Got it, tip remains as designed. Peer pattern residual (howto-first OK). |
| **HP-I1834-002** | **Low** | Share user-cancel → clipboard | `navigator.share(...).catch(() => copyShare)` copies on dismiss/fail (same as several peer PWAs). Acceptable; not a ship blocker. |

### Carried residuals (from MVP `QA-REPORT.md`)

| ID | Severity | Title |
|----|----------|-------|
| Prior P3-1 | Low | Mute preference-only (no SFX path) — out of IMPROVE scope |
| Prior P3-2 | Low | Resize listener accumulate on play shell |
| Prior P3-3 | Low | Late pack often shallow BFS |
| Prior P3-4 | Low | Color-count vs capacity heuristic on some mid levels |
| Prior P3-5 | Low | No live airplane-mode toggle this cycle |

---

## CLEAR from QA?

**YES** — Unreleased IMPROVE-1834 polish is CLEAR from QA for publish (host under `base: /hexpour/`). No P0/P1. Do not amend `c3841cc` or tag `v0.1.0`.
