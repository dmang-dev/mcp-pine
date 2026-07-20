# docs/

Design notes and recipes referenced from the top-level `README.md`.

## Files

- **`RECIPES.md`** — end-to-end workflows against PCSX2 (and RPCS3 where
  tested): RAM hunting, struct decoding, snapshot-experiment-restore on PS2.
  Mostly worked against the homebrew ROMs in `../homebrew_games/`.
- **`SCOPE.md`** — capability matrix vs. sister projects. PINE exposes
  memory + savestate only — no input, no screenshot, no pause/step/reset
  (PINE protocol limitation, not a bridge limitation). Documents the gap
  honestly so users pick the right bridge for their workload.
