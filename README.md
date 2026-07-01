# mcp-pine

[![npm version](https://img.shields.io/npm/v/mcp-pine.svg)](https://www.npmjs.com/package/mcp-pine)
[![npm downloads](https://img.shields.io/npm/dm/mcp-pine.svg)](https://www.npmjs.com/package/mcp-pine)
[![CI](https://github.com/dmang-dev/mcp-pine/actions/workflows/ci.yml/badge.svg)](https://github.com/dmang-dev/mcp-pine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/mcp-pine.svg)](LICENSE)
[![Snyk](https://snyk.io/test/npm/mcp-pine/badge.svg)](https://snyk.io/test/npm/mcp-pine)
[![Socket](https://img.shields.io/badge/Socket-security-2F7BFF?logo=socket)](https://socket.dev/npm/package/mcp-pine)
[![Bundlephobia](https://img.shields.io/badge/bundlephobia-size-FF6B81)](https://bundlephobia.com/package/mcp-pine)
[![npmgraph](https://img.shields.io/badge/npmgraph-dependencies-2496ED)](https://npmgraph.js.org/?q=mcp-pine)

An [MCP](https://modelcontextprotocol.io) server for emulators that speak [PINE](https://github.com/GovanifY/pine) (Protocol for Instrumentation of Network Emulators) — first-class support for **PCSX2** (PS2) and **RPCS3** (PS3), with target-aware tool descriptions so the agent sees the right memory map for whichever emulator it's pointed at. Exposes memory read/write and savestate control. Driven from MCP-compatible clients (Claude Desktop, Claude Code, etc.).

## What you can do with it

- **Read & write emulated memory** — 8/16/32/64-bit, anywhere in the emulator's address space (PS2 EE for PCSX2, PPU main memory for RPCS3)
- **Trigger save / load state** to numbered slots
- **Query game metadata** — title, serial, disc CRC, version
- **Inspect emulator state** — running / paused / shutdown

Tool descriptions, memory-map context, and setup help are rendered **per-target** at startup — set `PINE_TARGET=rpcs3` and every memory-tool description shows PS3 PPU addresses instead of PS2 EE addresses.

What you **can't** do (because PINE itself doesn't expose these):
- Send controller input
- Take screenshots
- Step / pause / reset the emulator

This makes mcp-pine well-suited for **memory inspection, cheat / RAM hunting, savestate automation, and reverse engineering**, but not for "play games via Claude." For input + screenshot capability on Game Boy Advance, see the sister project [mcp-mgba](https://github.com/dmang-dev/mcp-mgba).

## How it works

```
+----------------+    stdio     +----------------+   PINE socket    +-----------------+
|   MCP client   |   JSON-RPC   |    mcp-pine    |  (TCP or Unix)   |    Emulator     |
|  (Claude etc.) | -----------> |   (Node.js)    | ---------------> |  (PINE server)  |
+----------------+              +----------------+                  +-----------------+
```

`mcp-pine` opens a loopback connection to the emulator's PINE server (TCP on Windows, Unix domain socket on Linux/macOS) and translates each MCP tool call into a binary PINE message.

## Compatible emulators

| Emulator         | Platform      | PINE built in?                            | Default slot | `PINE_TARGET` |
|------------------|---------------|-------------------------------------------|--------------|---------------|
| **PCSX2 ≥ 1.7** ([setup](#pcsx2)) | PlayStation 2 | ✅ Yes (toggle in settings)              | 28011 | `pcsx2` (default) |
| **RPCS3** ([setup](#rpcs3))       | PlayStation 3 | ⚠️ Has IPC with PINE-compatible opcodes — verify before relying on it | 28012 | `rpcs3` |

Other emulators implementing the PINE spec should work out of the box once you point `mcp-pine` at the right slot — open an issue if you've tested one and it works.

**Note on DuckStation (PS1)**: DuckStation had PINE support from May–September 2024 but [dropped it in commit 19698559](https://github.com/stenzek/duckstation/commit/19698559). Current builds have no PINE server. If upstream brings it back, `PINE_TARGET=duckstation` is reserved.

Setting `PINE_TARGET` does two things: (1) selects the right Unix socket filename on Linux/macOS, and (2) renders all tool descriptions, memory maps, and setup help for that emulator's address space. Default is `pcsx2` for back-compat.

## Requirements

- An emulator with PINE enabled (see setup below)
- **Node.js 22+**

## Install

### Option A — install from npm (recommended)

```bash
npm install -g mcp-pine
```

Verify with `mcp-pine` (it prints a startup line and waits for stdio — `Ctrl+C` to exit).

### Option B — `npx` (no install)

```bash
npx -y mcp-pine
```

### Option C — clone and develop

```bash
git clone https://github.com/dmang-dev/mcp-pine
cd mcp-pine
npm install        # also runs the build via the `prepare` hook
```

## Emulator setup

### PCSX2

1. Launch PCSX2 (1.7.x Qt or newer).
2. **Settings → Advanced → Enable PINE Server** (the option may live under a different submenu in some builds — search the settings for "PINE").
3. Default slot is **28011**. If you change it, set `PINE_SLOT` for `mcp-pine`.
4. Load any game.

That's it — no scripts, no console commands. PINE is always-on once the toggle is set.

### RPCS3

RPCS3 has its own IPC implementation that mirrors PINE's opcode set, but the wire-level compatibility hasn't been thoroughly tested with this client. To try it:

1. **Configuration → Advanced → Enable IPC server** (or similar — check current RPCS3 docs).
2. Note the configured port.
3. Run with `PINE_TARGET=rpcs3 PINE_SLOT=<port> mcp-pine`.

If something doesn't work, please file an issue with details.


## Register with your MCP client

### Claude Code (CLI)

```bash
claude mcp add pine --scope user mcp-pine
```

Verify:
```bash
claude mcp list
# pine: mcp-pine - ✓ Connected
```

### Claude Desktop

Edit `claude_desktop_config.json`:

| Platform | Path |
|---|---|
| macOS    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows  | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux    | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "pine": {
      "command": "mcp-pine"
    }
  }
}
```

Restart Claude Desktop after editing.

### Other MCP clients

`mcp-pine` speaks standard MCP over stdio. Run it and connect any compatible client.

## Configuration

| Env var             | Default       | Purpose |
|---------------------|---------------|---------|
| `PINE_TARGET`       | `pcsx2`       | Emulator name. Known values: `pcsx2`, `rpcs3`. Selects (1) the Unix socket file prefix on Linux/macOS (`<target>.sock.<slot>`), and (2) the memory map and setup help shown in tool descriptions. Unknown values pass through with a generic memory map. |
| `PINE_SLOT`         | target default | PINE slot — also the TCP port on Windows. Defaults: `pcsx2`=28011, `rpcs3`=28012. Set explicitly to override. |
| `PINE_HOST`         | `127.0.0.1`   | Override the host (TCP only) |
| `PINE_SOCKET_PATH`  | (auto)        | Override the full Unix socket path on Linux/macOS, bypassing automatic resolution |

## Tools

| Tool | Description |
|------|-------------|
| `pine_ping` | Verify the connection by querying the emulator version |
| `pine_get_info` | Title, serial (e.g. `SLUS-21274`), disc CRC, game version, status |
| `pine_get_status` | Just the running/paused/shutdown state |
| `pine_read8` / `pine_read16` / `pine_read32` / `pine_read64` | Read memory |
| `pine_read_range` | Bulk read up to 4096 bytes (client-side pipelined PINE calls) |
| `pine_write8` / `pine_write16` / `pine_write32` / `pine_write64` | Write memory (RAM only — ROM writes are silently dropped) |
| `pine_save_state` | Trigger save state to a numbered slot (0-255) |
| `pine_load_state` | Trigger load state from a numbered slot (0-255) |

See [`docs/RECIPES.md`](docs/RECIPES.md) for end-to-end examples (RAM hunting, struct decoding, snapshot-experiment-restore).

### PlayStation 2 address space (PCSX2, default target)

| Range | Region |
|-------|--------|
| `0x00100000-0x01FFFFFF` | EE main RAM (32 MiB) — **start here for game data** |
| `0x10000000` | Hardware registers (DMA, GIF, VIF) |
| `0x11000000` | VU0 / VU1 memory |
| `0x12000000` | GS privileged registers |
| `0x1C000000-0x1C1FFFFF` | IOP RAM (2 MiB) |
| `0x1F800000` | IOP scratchpad |
| `0x70000000` | EE scratchpad (16 KiB) |


## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Cannot reach PINE server` | Emulator isn't running, PINE isn't enabled in its settings, or the slot/port doesn't match. Check `PINE_SLOT`. |
| `PINE FAIL response` (0xFF) | The emulator rejected the request — most often because no game is loaded, or the address is unmapped. |
| Reads return zeros | Address is in an unallocated region. Try `0x00100000` first (almost always inside loaded EE RAM). |
| Tool calls work but values look corrupted | Check endianness expectations — PINE returns little-endian; if you're interpreting strings, use `read_range`-style byte reads. |
| `PINE call timed out (10s)` from `pine_ping` after some heavy use | **PCSX2's PINE server can wedge.** Its request queue is fragile — if a third-party tool pipelines too aggressively (more than ~6 in-flight requests) it silently drops requests, and from then on every reply is mis-aligned with the wrong waiting client. Symptom: even a fresh `pine_ping` times out. **Fix: fully restart PCSX2.** Reconnecting alone won't help — the corruption is on the emulator side. |
| `pine_read_range` slower than mGBA's `read_range` | Expected. PINE has no native bulk read, so we issue calls **serially** (pipelining can wedge PCSX2 — see above). Loopback TCP is fast enough that this isn't usually a problem: measured ~52 ms for a full 4096-byte read on PCSX2 v2.6.3. For workloads that need lower latency and can tolerate occasional emulator restarts, set `PINE_PIPELINE_BATCH=2`. |

## Development

```bash
npm install
npm run dev      # tsc --watch
```

Quick smoke test against a running PCSX2:

```bash
node .scratch/smoke.cjs
```

## Debugging with the MCP Inspector

Browse and call this server's tools interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
PINE_TARGET=pcsx2 npm run inspector
```

Build first if you've edited `src/` since your last `npm install` (`npm run build`, or keep `npm run dev` running). Set `PINE_TARGET` (`pcsx2` default, or `rpcs3`) and `PINE_SLOT` to match your emulator — e.g. `PINE_TARGET=rpcs3 PINE_SLOT=28012 npm run inspector`. `tools/list` works even without an emulator connected; *calling* a tool needs PCSX2 (or RPCS3) running with PINE/IPC enabled.

## License

[MIT](LICENSE)

## Related

- [mcp-mgba](https://github.com/dmang-dev/mcp-mgba) — sister MCP server for the mGBA Game Boy Advance emulator (also includes button input + screenshot, which PINE doesn't expose)
- [PINE protocol spec](https://github.com/GovanifY/pine) — the underlying IPC standard
