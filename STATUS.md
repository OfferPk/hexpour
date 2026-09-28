# HexPour — STATUS

**Status:** READY_FOR_QA  
**Updated:** 2026-09-28T18:45:00+05:00 (PKT)  
**Version:** 0.1.0 (SHIPPED) + Unreleased polish  
**Project ID:** `proj_hexpour_001`  
**Path:** `/workspace/factory/projects/hexpour`  
**Release source SHA:** `754788616ea56933efaff1ef4581fe6b312decc4` (`7547886`, not amended)  
**Pages:** https://offerpk.github.io/hexpour/

## Gates

| Gate | Result |
|------|--------|
| QA | **PASS** (v0.1.0) — Unreleased polish pending QA |
| Security | **PASS_WITH_NOTES** — clear to ship; no blockers |
| `npm test` | see latest commit notes |
| `npm run build` | see latest commit notes |

## Unreleased polish (post v0.1.0)

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

## Notes

- Original soft-hive theme; no Hexa Sort / Hex Match / TubeSort IP or branding.
- Keep `base: '/hexpour/'` in `vite.config.ts`.
