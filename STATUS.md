# HexPour — STATUS

**Status:** SHIPPED  
**Updated:** 2026-09-28T18:45:28+05:00 (PKT)  
**Version:** 0.1.1 (SHIPPED)  
**Project ID:** `proj_hexpour_001`  
**Path:** `/workspace/factory/projects/hexpour`  
**Release source SHA:** `c3841cc62084d492d1cf1e9385d5e79a37d9b1eb` (`c3841cc`, dual-cleared; not amended)
**Release commit:** `d1635466138ce3e67815dfd9106cdd2163acf34a` (`d163546`)  
**Pages:** https://offerpk.github.io/hexpour/

## Gates

| Gate | Result |
|------|--------|
| QA | **PASS** (IMPROVE-1834) @ `c3841cc` |
| Security | **PASS_WITH_NOTES** @ `c3841cc` — clear to ship; no blockers; no security code edits |
| `npm test` | **17/17 passed** |
| `npm run build` | **green** |

## v0.1.1 polish (post v0.1.0)

IMPROVE delta — do **not** amend tag `v0.1.0` or rewrite release commits:

1. First-run howto overlay + Home **How to play** (`localStorage` `hexpour:howto`)
2. Win **Share** (`navigator.share` + clipboard fallback + toast)
3. Home soft A2HS tip (session dismiss `hexpour:a2hs`)

Pages base remains `/hexpour/`. No level JSON / generator / TubeSort / ads / mute→SFX / daily challenge changes.

## v0.1.0 release (SHIPPED)

HexPour MVP: flat-top axial hex pour, 40 BFS-solvable levels, unlimited undo, hint and ads stubs, Home / levels / play / win screens, progress persistence, PWA offline shell, README, and Roman Urdu guide.

Dual-clear: QA PASS + Security PASS_WITH_NOTES. Security notes are non-blocking (local progress range hardening, `.env*` ignore hygiene, dev-only Vitest audit findings, and host CSP guidance). No security code edits were made.

## Deployment

- Repository: https://github.com/OfferPk/hexpour
- Release: https://github.com/OfferPk/hexpour/releases/tag/v0.1.0
- GitHub Pages base: `/hexpour/`
- Deployment branch: `gh-pages`
- `.nojekyll`: included for Pages
- Pages deploy commit: `9ce2ac63328c590b0e394b478828a19ab2621514` (`9ce2ac6`)

## Notes

- Original soft-hive theme; no Hexa Sort / Hex Match / TubeSort IP or branding.
- Keep `base: '/hexpour/'` in `vite.config.ts`.
