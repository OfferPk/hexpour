# HexPour — Security Review Report

**Date:** 2026-09-28 18:24 PKT (Asia/Karachi, UTC+05:00)  
**Project:** `/workspace/factory/projects/hexpour`  
**HEAD reviewed:** `7547886` (`754788616ea56933efaff1ef4581fe6b312decc4`) — feat(hexpour): MVP 0.1.0 READY_FOR_QA  
**Version:** 0.1.0  
**Reviewer:** Security Reviewer (executor)  
**Gate:** `/workspace/factory/shared/security/RELEASE_GATE.md`  
**Verdict:** **PASS_WITH_NOTES**  
**Sign-off:** **CLEAR** (no ship blockers)

**Statement:** No product code was edited. No git push was performed. Commit `7547886` was not amended.

---

## Ship blockers

**None.**

No secrets/API keys/tokens in source or build, no exploitable XSS from untrusted input, no unexpected network/telemetry/live AdMob SDKs, no privileged auth surface, production dependency audit clean (`npm audit --omit=dev` → 0 vulnerabilities).

---

## Master focus summary

| Focus | Result |
|-------|--------|
| 1. XSS / storage / UI | **PASS** — `esc()` on dynamic modal strings; level ids numeric; toast `textContent`; canvas has no DOM XSS |
| 2. localStorage hygiene | **PASS_WITH_NOTES** — key `hexpour_v1`; booleans `=== true`; unlocked typed as number but **not clamped** (F1) |
| 3. Deps audit | **PASS** — prod audit 0; vitest-only moderate in full audit (F3) |
| 4. Secrets | **PASS** — none; ads stubs only (`src/ads/stubs.ts`) |
| 5. CSP / headers | **Info** — no CSP meta in `index.html` (typical for these PWAs; Pages host can add headers) |
| 6. Offline | **PASS** — no app fetch/beacon/analytics; Workbox precache only |
| 7. `.gitignore` | **Note** — missing `.env*` (F2), like other early MVPs |

---

## Findings

### F1 — `unlocked` not clamped to a sane range (Low / note)

- **File:** `src/game/persist.ts:22`
- **Evidence:** `unlocked: typeof parsed.unlocked === 'number' ? parsed.unlocked : 1` — accepts any JS number (`NaN`, `Infinity`, negatives, values ≫ `LEVEL_COUNT`). Booleans correctly require `=== true` (`adsRemoved` / `mute` at lines 23–24).
- **Risk:** Client-side progress tampering only (offline game; no server trust). Play path uses `Math.min(persist.unlocked, LEVEL_COUNT)` (`src/ui/app.ts:167`); level-grid lock checks can unlock all levels if `unlocked` is inflated.
- **Remediation (non-blocking):** Coerce with `Number.isFinite` and clamp e.g. `Math.min(LEVEL_COUNT, Math.max(1, Math.floor(n)))` on read.
- **Severity:** Low / note — not a RELEASE_GATE ship blocker.

### F2 — `.gitignore` omits `.env*` patterns (Info / note)

- **File:** `.gitignore` (lines: `node_modules`, `dist`, `.DS_Store`, `*.local`, `.dev-dist`)
- **Evidence:** No `.env`, `.env.*`, or `!.env.example`. No `.env` files present in tree; no secret-like paths tracked.
- **Risk:** Accidental commit of future AdMob/IAP env files when live ads land.
- **Remediation (non-blocking):** Add `.env`, `.env.*`, `!.env.example` before introducing real keys.

### F3 — Full `npm audit` moderate findings are Vitest-only (Info / note)

- **Evidence:** `npm audit --omit=dev` → **0 vulnerabilities** (zero production `dependencies` in `package.json`). Full audit: 2 moderate in `@vitest/mocker` / `vitest` (GHSA-82fw-gwwq-j7x9) — **dev/test tree only**, not shipped in `dist/`.
- **Risk:** Local/CI Vitest misuse only; not a runtime ship risk for the offline PWA.
- **Remediation (non-blocking):** Plan Vitest upgrade when convenient; do not expose Vitest tooling to untrusted networks.

### F4 — CSP meta absent in `index.html` (Info)

- **File:** `index.html` (no `Content-Security-Policy` meta)
- **Evidence:** Typical for factory offline PWAs hosted on GitHub Pages; headers belong on the host.
- **Risk:** None for this client-only MVP with no third-party scripts.
- **Remediation (optional):** When Pages (or other host) supports custom headers, prefer CSP restricting `script-src`/`connect-src` to same-origin; keep Workbox/SW registration compatible.

---

## Checklist (RELEASE_GATE)

| # | Area | Status | Notes |
|---|------|--------|-------|
| 1 | Authn / sessions / tokens | N/A → PASS | No accounts, cookies, or tokens |
| 2 | Authz / IDOR / roles | N/A → PASS | Client-only game; no privileged routes |
| 3 | Secrets & config | PASS | No keys; ads are stubs (`src/ads/stubs.ts`) |
| 4 | API surface & rate limits | N/A → PASS | No app API |
| 5 | Injection (XSS / eval / HTML) | PASS | See XSS detail below; no `eval` / `document.write` / `outerHTML` / `insertAdjacentHTML` |
| 6 | Uploads & file access | N/A → PASS | None |
| 7 | Dependencies & supply chain | PASS | Prod audit clean; F3 notes vitest-only |
| 8 | Logging / error leakage | PASS | Ad stub in-memory `log` only; no remote logging |
| 9 | Transport (TLS / cookies / HSTS) | N/A → PASS | Static Pages host; no cookie auth; CSP note F4 |
| 10 | Admin / debug surfaces | PASS | No debug endpoints |

### Focus detail

**XSS / UI (`src/ui/app.ts`)**  
- `esc()` at lines 494–500 escapes `& < > "` before any dynamic `innerHTML` interpolation.  
- Ad stub modals (`95`, `116`): `esc(title)` / `esc(body)` — reasons are app-controlled (`hint` / `restart` / `win` / `generic`).  
- Home hero (`155–163`) and settings labels (`185`, `195`): static markup only.  
- Win screen (`453–455`): interpolates `levelId` (always a number from `startLevel` / `getLevel`); level-select buttons use `textContent` with loop index `i` (`245`).  
- Toast: `el.toast.textContent = msg` (`81`). Buttons use `textContent` (`488`).  
- Canvas renderer (`src/render/hexBoard.ts`): draws stacks/colors only — no DOM/HTML from level JSON. Levels are first-party static JSON imports (`src/levels/index.ts` + `level-01.json`…`level-40.json`).

**localStorage (`src/game/persist.ts`)**  
- Key: `hexpour_v1`  
- Fields: `unlocked` (number), `adsRemoved`, `mute` — progress/flags only; **no credentials**  
- Hardening: `try/catch` on read/write; `adsRemoved`/`mute` require `=== true`; unlocked type-check only (see F1)  
- Consumed for lock UI / settings labels via `textContent` or numeric compare — not HTML-interpolated as strings from storage

**Ads stubs (`src/ads/stubs.ts`)**  
- `showInterstitial` / `showRewarded` / `purchaseRemoveAds` / `isAdsRemoved`  
- UI presenters in `app.ts` are overlay stubs (`Ad stub — Interstitial` / `Rewarded`); no AdMob SDK, no `ca-app-pub`, no network ads  
- `purchaseRemoveAds` only sets `adsRemoved: true` in localStorage

**PWA / base / offline**  
- `vite.config.ts`: `base: '/hexpour/'`; Workbox `globPatterns` for static assets; `manifest: false` (uses `public/manifest.webmanifest` with `scope`/`start_url` `/hexpour/`)  
- `src/main.ts`: `registerSW({ immediate: true })` from `virtual:pwa-register`  
- Build evidence: `dist/sw.js` precaches app assets + `NavigationRoute` → `index.html` only — no unexpected remote URLs  
- Grep: no app `fetch(`, `sendBeacon`, `XMLHttpRequest`, `gtag`, `analytics`, `admob` in `src/` / `public/` / `index.html`

**Secrets**  
- No API keys, tokens, passwords, or `.env` files in source/public/dist. Package has **zero** production dependencies.

---

## Commands run (evidence)

| Command | Result |
|---------|--------|
| `git rev-parse HEAD` | `754788616ea56933efaff1ef4581fe6b312decc4` |
| `npm test` | **17/17 passed** (hex 3 + ads 3 + pour 11) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` (full) | 2 moderate (vitest / @vitest/mocker only) |
| Grep sinks / network / secrets | As above; no committed secrets |

**Not done (per brief):** no product code edits; no git push; SHA `7547886` not amended.

---

## Notes

- Client-controlled `localStorage` progress (unlock, adsRemoved stub, mute) is tamperable by design for an offline game — not a ship blocker with no server trust boundary.
- Untracked working-tree file `_qa_bfs_probe.ts` observed at review time; not part of HEAD `7547886` and not reviewed as product surface.
- CSP/headers for GitHub Pages remain a hosting concern (F4); MVP ships without inline CSP meta consistently with peer factory PWAs.

---

## Sign-off

**Verdict:** PASS_WITH_NOTES  
**Ship blockers:** none  
**Sign-off:** **CLEAR** — eligible for QA / Master dual-clear publish path once Product/QA gates pass. Address F1–F4 as polish, not blockers.

Report path: `/workspace/factory/projects/hexpour/SECURITY-REPORT.md`
