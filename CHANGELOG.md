# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/dmang-dev/mcp-pine/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dmang-dev/mcp-pine/releases/tag/v0.1.0
