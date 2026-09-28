# HexPour — STATUS

| Field | Value |
|-------|--------|
| **Project ID** | `proj_hexpour_001` |
| **Slug** | `hexpour` |
| **Version** | 0.1.0 |
| **Path** | `/workspace/factory/projects/hexpour` |
| **Status** | `READY_FOR_QA` |
| **Updated** | 2026-09-28 (Asia/Karachi) |

## Pipeline

PRD_READY → BUILD → **READY_FOR_QA** → (await QA) → Master dual-clear → push

## Gates

- [x] Vite + TS + PWA; `base: '/hexpour/'`
- [x] Flat-top axial hex math + canvas renderer; stacks in hexes
- [x] Pour engine: adjacency, capacity, same-color runs, blocked cells, win
- [x] 40 JSON levels
- [x] Unlimited undo + hint (1 free / rewarded stub)
- [x] Ads stubs wired in UI
- [x] Home / levels / play / win + mute/settings
- [x] localStorage progress
- [x] Vitest + build green
- [x] README + GUIDE-roman-urdu + CHANGELOG
- [ ] QA pass
- [ ] Master dual-clear
- [ ] git push (blocked until dual-clear)

## Notes

TubeSort remains SKIPPED. Original soft-hive theme — no Hexa Sort / Hex Match IP.
