# HexPour — Security Review Report (IMPROVE-1834 Unreleased polish)

| Field | Value |
|-------|--------|
| **Project** | HexPour |
| **Path** | `/workspace/factory/projects/hexpour` |
| **Scope** | Unreleased IMPROVE post-v0.1.0 — howto overlay, win Share, home A2HS (IMPROVE-1834) |
| **HEAD** | `c3841cc` (`c3841cc62084d492d1cf1e9385d5e79a37d9b1eb`) — feat(hexpour): howto, win share, home A2HS (Unreleased) |
| **Prior** | `SECURITY-REPORT.md` @ `7547886` — **PASS_WITH_NOTES** / **CLEAR** |
| **Review date** | 2026-09-28 18:39 PKT (Asia/Karachi, UTC+05:00) |
| **Reviewer** | Security Reviewer (executor) |
| **Gate** | `/workspace/factory/shared/security/RELEASE_GATE.md` |
| **Verdict** | **PASS_WITH_NOTES** |
| **Sign-off** | **CLEAR** (no ship blockers) |

**Statement:** No product code was edited. No git push was performed. Commit `c3841cc` was not amended. Prior `SECURITY-REPORT.md` preserved untouched.

---

## Ship blockers

**None.**

No secrets/API keys/tokens in source or build; no exploitable XSS from untrusted input or storage; share/clipboard/session-only (no new network); ads stubs unchanged; production dependency audit clean (`npm audit --omit=dev` → 0 vulnerabilities). Prior F1 (unlocked clamp) **CLOSED** in this pack.

---

## Master focus checklist

| # | Focus | Result |
|---|--------|--------|
| 1 | **Howto overlay + `hexpour:howto`** | **PASS** — Flag key `hexpour:howto` (`persist.ts:4`); `isHowtoSeen` strict `localStorage.getItem(HOWTO_KEY) === '1'` (`persist.ts:89–94`); `markHowtoSeen` writes `'1'` only (`persist.ts:97–102`). Boot: `if (!isHowtoSeen()) openHowto(true)` (`app.ts:614–616`); Got it → `markHowtoSeen()` then Home (`app.ts:173–183`). Flag value never interpolated into DOM — boolean gate only. Non-`'1'` (incl. crafted XSS payloads) → treated as unseen; no injection. |
| 1b | **Howto `li.innerHTML` (~162)** | **PASS** — `bullets` array (`app.ts:152–159`) is **static trusted string literals** only (`<strong>` emphasis). Loop `li.innerHTML = html` (`app.ts:160–163`) never reads user input, `localStorage`, or URL params. Urdu line uses `textContent` (`app.ts:167–169`). Title uses `textContent` (`app.ts:146–147`). |
| 2 | **Win Share** | **PASS** — `shareWin` (`app.ts:218–231`): plain text `HexPour — hive clear! Level ${levelId}` + optional `· unlocked through ${persist.unlocked}`. `levelId` is numeric game state; `unlocked` is clamped finite int (1–40). Path: `navigator.share({ title, text })` or `clipboard.writeText` / `legacyCopy` via `textarea.value` (`app.ts:189–216`) — **never** assigned to `innerHTML`. Toast: static `'Copied'` via `showToast` → `el.toast.textContent` (`app.ts:84–87,206`). No share URL/network. |
| 3 | **Home A2HS tip** | **PASS** — Key `hexpour:a2hs` (`persist.ts:7` / `A2HS_KEY`); dismiss check `sessionStorage.getItem(A2HS_KEY) === '1'` (`app.ts:233–238`); write `'1'` on Got it (`app.ts:241–246`). `copy.innerHTML` (`app.ts:300–301`) is **static HTML only** (`<strong>Add to Home Screen</strong>` + fixed Roman Urdu span). No `beforeinstallprompt` listener/handler anywhere under `src/`. Tip Home-only; hidden when dismissed or standalone (`app.ts:296–310`). |
| 4 | **No new network / secrets** | **PASS** — Delta uses share API, clipboard, `localStorage`/`sessionStorage` only. Grep `src/`/`public/`/`index.html`: no app `fetch(`, `sendBeacon`, `XMLHttpRequest`, `WebSocket`, `gtag`, `analytics`, `admob`, `ca-app-pub`. Ads stubs last touched at MVP `7547886` — unchanged. Zero production `dependencies`. No `.env` files in tree. |

---

## Prior notes status (vs `7547886` / SECURITY-REPORT.md)

| ID | Topic | Status |
|----|--------|--------|
| **F1** | `unlocked` not clamped | **CLOSED** — `clampUnlocked` with `Number.isFinite` + floor + bound `[1, UNLOCKED_MAX=40]` on read/save/unlock (`persist.ts:9–10,25–28,36–38,62–63,74`). Addresses prior remediation. |
| **F2** | `.gitignore` missing `.env*` | **OPEN** (Info / note) — still only `node_modules`, `dist`, `.DS_Store`, `*.local`, `.dev-dist`. No `.env` present; no secrets tracked. Remains non-blocking until live AdMob/IAP keys. |
| **F3** | Vitest-only moderate audit | **OPEN** (Info) — unchanged: `npm audit --omit=dev` → **0**; full audit 2 moderate (`vitest` / `@vitest/mocker` GHSA-82fw-gwwq-j7x9) — **dev/test only**, not in `dist/`. |
| **F4** | CSP meta absent | **OPEN** (Info) — `index.html` still has no CSP meta; host-header concern for Pages; consistent with peer factory PWAs. |

**No regression** of prior CLEAR posture; F1 improved.

---

## Delta findings (this pack)

### D1 — Howto flag boolean-only, not injectable (Info / Safe) — **NEW**

| | |
|--|--|
| **Severity** | Info |
| **Evidence** | `src/game/persist.ts:4,89–102`; `src/ui/app.ts:173–174,614–616` |
| **Detail** | Separate key from save blob. Strict `=== '1'`. Value never HTML-interpolated. |

### D2 — Howto bullets `innerHTML` from static literals only (Info / Safe) — **NEW**

| | |
|--|--|
| **Severity** | Info |
| **Evidence** | `src/ui/app.ts:152–163` |
| **Detail** | Trusted compile-time strings with `<strong>` only; no storage/user data in the array. Prefer `textContent` + nested `<strong>` elements in a future polish if `innerHTML` hygiene is tightened further — not required for ship. |

### D3 — Win share / clipboard plain-text only (Info / Safe) — **NEW**

| | |
|--|--|
| **Severity** | Info |
| **Evidence** | `src/ui/app.ts:189–231,84–87,605` |
| **Detail** | Numeric level + clamped unlock in share string; toast `textContent`; no HTML sink for share payload. |

### D4 — A2HS tip static HTML + session flag (Info / Safe) — **NEW**

| | |
|--|--|
| **Severity** | Info |
| **Evidence** | `src/ui/app.ts:233–255,296–310`; `src/game/persist.ts:7` |
| **Detail** | Static `innerHTML`; session dismiss `=== '1'`; no `beforeinstallprompt` / install-prompt network. |

### D5 — Prior F1 unlocked clamp landed (Info / Positive) — **CLOSED prior**

| | |
|--|--|
| **Severity** | Info |
| **Evidence** | `src/game/persist.ts:25–28,36–38,62–63,74` |
| **Detail** | Optional IMPROVE note completed while touching `persist.ts` for howto. |

---

## Checklist (RELEASE_GATE)

| # | Area | Status | Notes |
|---|------|--------|-------|
| 1 | Authn / sessions / tokens | N/A → PASS | No accounts; howto/A2HS flags are UX booleans only |
| 2 | Authz / IDOR / roles | N/A → PASS | Client-only game |
| 3 | Secrets & config | PASS | None; ads stubs unchanged; F2 `.env*` note remains |
| 4 | API surface & rate limits | N/A → PASS | No app API |
| 5 | Injection (XSS / eval / HTML) | PASS | Focus 1–3; `esc()` retained on ad stub modals; no `eval` / `document.write` / `insertAdjacentHTML` / `outerHTML` |
| 6 | Uploads & file access | N/A → PASS | None |
| 7 | Dependencies & supply chain | PASS | Prod audit 0; F3 vitest-only |
| 8 | Logging / error leakage | PASS | No remote logging; ad stub in-memory only |
| 9 | Transport (TLS / cookies / HSTS) | N/A → PASS | Static Pages; CSP note F4 |
| 10 | Admin / debug surfaces | PASS | None |

---

## Commands run (evidence)

| Command | Result |
|---------|--------|
| `git rev-parse HEAD` | `c3841cc62084d492d1cf1e9385d5e79a37d9b1eb` |
| `npm test` | **17/17 passed** (hex 3 + ads 3 + pour 11) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` (full) | 2 moderate (vitest / @vitest/mocker only) |
| Grep sinks / network / secrets / `beforeinstallprompt` | As Master focus; no committed secrets; no new network |

**Not done (per brief):** no product code edits; no git push; SHA `c3841cc` not amended; prior `SECURITY-REPORT.md` not overwritten.

---

## Notes

- Working tree at review time showed unstaged `src/levels/level-18.json` churn — **not part of HEAD `c3841cc`**; not reviewed as this IMPROVE surface.
- Client-controlled progress / flags remain tamperable by design for an offline PWA — not a ship blocker with no server trust boundary.
- Win hero still interpolates numeric `levelId` into static template `innerHTML` (`app.ts:590–593`) — same safe pattern as prior MVP review.

---

## Sign-off

**Verdict:** PASS_WITH_NOTES  
**Ship blockers:** none  
**Sign-off:** **CLEAR** — eligible for QA / Master dual-clear improve publish path once Product/QA gates pass. Residual notes: F2 (`.gitignore` `.env*`), F3 (vitest moderate), F4 (CSP host). Prior F1 closed.

Report path: `/workspace/factory/projects/hexpour/SECURITY-REPORT-IMPROVE-1839.md`
