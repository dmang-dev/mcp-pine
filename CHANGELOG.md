# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-18

Target-aware tool descriptions. mcp-pine has always supported any
PINE-speaking emulator at the protocol level, but the tool
descriptions were hardcoded around PCSX2's EE memory map — an agent
pointed at RPCS3 still saw PS2 addresses in its tool docs. v0.3.0
moves all that context behind a `TargetInfo` table and renders
descriptions per-target at startup.

### Added

- **`src/targets.ts`** with `TargetInfo` records for PCSX2 and RPCS3.
  Each carries: display name, system, default PINE slot, address-space
  label, useful-range hint, full memory map (multi-line cheat sheet
  baked into every memory-tool description), startup help string,
  savestate file layout, and per-emulator alignment notes.
- **`PINE_SLOT`** now defaults to the *target's* default slot when
  unset (28011 for pcsx2, 28012 for rpcs3), rather than always 28011.
- **Unknown `PINE_TARGET` values** pass through with a generic memory
  map and a startup warning, so forward-compatibility with future
  PINE-speaking emulators doesn't require a code change.

### Changed

- **`tools.ts` is now a builder**: `buildTools(target)` returns a
  target-aware `Tool[]` instead of exporting a hard-coded array. Every
  memory tool description embeds `target.memoryMap` (was: hard-coded
  `PS2_REGIONS`), and address parameter docs interpolate
  `target.usefulRangeHint`, `target.addressSpaceName`, and
  `target.alignmentNote`. Savestate slot docs interpolate
  `target.savestateInfo`.
- **`registerTools(server, pine, target)`** — third arg added. External
  consumers (if any) need to pass a `TargetInfo`.
- **Startup help** when PINE isn't reachable now shows the *target's*
  setup steps (PCSX2 menu path for `pcsx2`, RPCS3 IPC notes for
  `rpcs3`) instead of always PCSX2.
- **Startup line** now logs the resolved target: `target=pcsx2 (PCSX2 — PlayStation 2)`.

### Note on DuckStation

Initial scoping for v0.3.0 targeted DuckStation as a third first-class
target, since PINE was the obvious vehicle for adding PS1 support.
Investigation surfaced that stenzek implemented PINE in DuckStation
in May 2024 (commit 4311e087) then **dropped it in September 2024**
(commit 19698559, "System: Drop IPC server"). Current DuckStation
builds have no PINE server to talk to. The `targets.ts` design
leaves an extension point for re-adding DuckStation if upstream
ever brings PINE back.

### Migration

Existing PCSX2 users: no action needed. `PINE_TARGET` defaults to
`pcsx2` and tool descriptions are unchanged in content. RPCS3 users
were previously stuck reading PCSX2 tool docs while running RPCS3 —
v0.3.0 fixes that.

[0.3.0]: https://github.com/dmang-dev/mcp-pine/releases/tag/v0.3.0

## [0.2.1] - 2026-05-15

Tool description quality pass — written to Glama's Tool Definition Quality
Score (TDQS) rubric so every tool maximizes Purpose Clarity, Usage
Guidelines, Behavioral Transparency, Parameter Semantics, Conciseness,
and Contextual Completeness.

### Changed

- **Every tool description rewritten to the PURPOSE / USAGE / BEHAVIOR /
  RETURNS template** — explicit error conditions, explicit
  when-to-use-this-vs-sibling guidance (e.g. read16 vs read32 vs
  read64; pine_read_range's pipeline-vs-serial trade-off), explicit
  destructive-behavior notes for state-mutating tools (`pine_write*`,
  `pine_save_state` slot overwrite), explicit return-value shape, and
  explicit alignment caveats (PCSX2 silently corrupts unaligned
  multi-byte access).
- **Every parameter now has a description** that adds context beyond
  the JSON Schema. PS2 memory landmarks (EE main RAM 0x00100000 -
  0x01FFFFFF, IOP RAM 0x1C000000+, scratchpad) inlined into address
  parameter docs.
- **64-bit value encoding** clarified — `pine_write64` / `pine_read64`
  use string-encoded decimal because JS can't represent the full u64
  range natively past 2^53.
- **Connection-failure modes** documented — Unix socket path
  (`$XDG_RUNTIME_DIR/<target>.sock.<slot>` with `$TMPDIR`/`/tmp`
  fallbacks) on Linux/macOS, TCP `127.0.0.1:<slot>` on Windows, and
  the 10-second per-call timeout.
- **PCSX2 pipeline drop bug** documented in `pine_read_range` — the
  bridge defaults to fully-serial requests; setting
  `PINE_PIPELINE_BATCH` opts in at risk of desyncing PCSX2.

## [0.2.0] - 2026-05-10

Bulk read + robustness pass.

### Added

- **`pine_read_range`** — bulk read up to 4096 bytes in one tool call.
  Implemented client-side as a serial sequence of PINE
  `read64`/`32`/`16`/`8` calls, choosing the largest aligned width at
  each step. Measured ~52 ms for a full 4096-byte read on PCSX2 v2.6.3
  over loopback.
- **10-second timeout on every PINE call** — if the emulator drops a
  reply (more on this in the discovered issue below), the call rejects
  cleanly instead of hanging the bridge forever.
- **`docs/RECIPES.md`** — cookbook of common workflows (RAM hunting,
  struct decoding, snapshot-experiment-restore) with copy-paste
  tool-call sequences.

### Discovered (worth knowing)

PCSX2's PINE server has a **fragile request queue**: dropping any
single request silently desyncs the reply pipeline, and from then on
every reply is mis-aligned with the wrong waiting client. Once
desynced, even a fresh `pine_ping` will time out — only an emulator
restart recovers.

We hit this empirically by pipelining ~7 mixed in-flight requests.
After investigation, `pine_read_range` issues calls **fully serially
by default** (`PINE_PIPELINE_BATCH=1`). Loopback TCP is fast enough
that this isn't a practical problem (52 ms for 4 KB). Power users can
set `PINE_PIPELINE_BATCH=2` or higher to trade safety for latency.

### Changed

- README troubleshooting section expanded with the wedged-PCSX2-PINE
  diagnostic and the new bulk-read latency profile.

## [0.1.0] - 2026-05-08

Initial public release.

### Added

- **PINE protocol client (`src/pine.ts`)** — implements the binary PINE wire
  format (uint32 size prefix, uint8 opcode, little-endian payload), with
  cross-platform transport: TCP loopback on Windows, Unix domain sockets on
  Linux/macOS (resolved via `XDG_RUNTIME_DIR` / `TMPDIR`).
- **MCP server (`dist/index.js`)** with lazy reconnect; emulator can be
  restarted without restarting the MCP host.
- **13 MCP tools**: `pine_ping`, `pine_get_info`, `pine_get_status`,
  `pine_read8/16/32/64`, `pine_write8/16/32/64`, `pine_save_state`,
  `pine_load_state`. 64-bit values are exchanged as decimal strings to
  preserve precision past `2^53`.
- **Configurable target** via `PINE_TARGET`, `PINE_SLOT`, `PINE_HOST`,
  `PINE_SOCKET_PATH` env vars — works with PCSX2 out of the box, can be
  pointed at any other PINE-speaking emulator.
- **Cross-platform install paths**: `npm install -g mcp-pine`,
  `npx -y mcp-pine`, or clone-and-build.
- **GitHub Actions CI** building on Node 18/20/22 across
  Linux / macOS / Windows.

### Known limitations

- PINE itself doesn't expose controller input, screenshot, or frame
  stepping. For an emulator MCP server with those capabilities, see
  [mcp-mgba](https://github.com/dmang-dev/mcp-mgba).

[Unreleased]: https://github.com/dmang-dev/mcp-pine/compare/v0.3.0...HEAD
[0.2.1]: https://github.com/dmang-dev/mcp-pine/releases/tag/v0.2.1
[0.2.0]: https://github.com/dmang-dev/mcp-pine/releases/tag/v0.2.0
[0.1.0]: https://github.com/dmang-dev/mcp-pine/releases/tag/v0.1.0
