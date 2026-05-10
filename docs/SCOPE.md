# mcp-pcsx2 — scope document

Status: planning. No code yet. Companion to [mcp-mgba](../mcp-mgba) — same architectural pattern, different transport.

## Premise

PCSX2 ships with **PINE** (Protocol for Instrumentation of Network Emulators), a built-in IPC server that exposes memory access and emulator control. Unlike mGBA — where we had to write a Lua bridge to expose IPC at all — PCSX2 already speaks a documented binary protocol on a loopback socket. **No emulator-side code needed.**

The MCP server is a thin TypeScript client that translates MCP tool calls into PINE messages.

## What we get from PINE

PCSX2's `PINE.cpp` implements these opcodes (verified against the master branch):

| Op  | Name           | Purpose |
|-----|----------------|---------|
| 0x00–0x07 | MsgRead8/16/32/64, MsgWrite8/16/32/64 | Memory r/w |
| 0x08 | MsgVersion     | PCSX2 version string |
| 0x09 | MsgSaveState   | Save to slot N |
| 0x0A | MsgLoadState   | Load from slot N |
| 0x0B | MsgTitle       | Game title |
| 0x0C | MsgID          | Game serial (e.g. `SLUS-21274`) |
| 0x0D | MsgUUID        | Disc CRC (hex) |
| 0x0E | MsgGameVersion | Game version from ELF |
| 0x0F | MsgStatus      | u32 — 0 running, 1 paused, 2 shutdown |

**That's the whole surface.** Nothing in the 0xD0–0xEF "target-specific" range is implemented today.

## What we DON'T get

| Capability        | mGBA | PCSX2 |
|-------------------|------|-------|
| Memory r/w        | ✅   | ✅    |
| Read range (bulk) | ✅   | ❌ (loop u64 reads instead) |
| Save / load state | ❌*  | ✅    |
| Game metadata     | ✅   | ✅ (richer — title + ID + CRC) |
| Status query      | ✅   | ✅    |
| Pause / resume    | ✅   | ❌    |
| Reset             | ✅   | ❌    |
| Frame advance     | ✅   | ❌    |
| **Button input**  | ✅   | ❌    |
| **Screenshot**    | ✅   | ❌    |

*mGBA has save state in its Lua API, we just didn't expose it; would be straightforward to add.

The two big gaps are **input** and **screenshot** — which, on the mGBA side, were what made the demo feel "alive" (Claude driving the game). Without those, the PCSX2 server is more of a memory-peek-and-savestate tool than a "play games via Claude" tool. Honest framing matters.

## Realistic use cases

What works well with the available surface:

- **Cheat / RAM discovery** — read regions, watch values change, find stable variable addresses
- **Game-state introspection** — feed Claude a memory map (e.g. from PCSX2's cheat database) and ask "where is the player on the map right now?"
- **Save-state automation** — load slot, do something, save slot, advance to scenario, repeat
- **Speedrun analysis** — read RNG seed, item drop tables, frame-perfect inventory
- **Reverse engineering** — interactive memory hunting with a model that has the disassembly in context

What doesn't work without input/screenshot:

- "Play this game for me"
- Visual reasoning — no way to see what's on screen
- Reaction-based interaction

## Workaround possibilities (not in MVP)

- **Screenshot via OS hotkey injection** — PCSX2 has F8 = screenshot. A host-OS module (Windows: PowerShell + `SendKeys`, Linux: `xdotool`, macOS: `osascript`) could trigger it and read the resulting PNG from PCSX2's screenshot folder. Out-of-band but feasible.
- **Input via OS keypress injection** — same approach, send keys to the PCSX2 window. Quality varies; timing-sensitive.
- **Framebuffer read via memory** — PS2 GS local memory could be decoded to RGB, but you have to handle PSMT4/8/16/24/32 texture formats, swizzling, and finding the active framebuffer pointer. Not a quick win — would be a project on its own.

I'd ship the MVP without any of these and add them later if there's demand. Better to have a clean, honest "memory + savestate" tool than a half-broken full-feature one.

## Wire format (verified from PINE spec)

```
Request:
  uint32_t  total_size_including_this_field
  uint8_t   opcode
  ...args (little-endian)

Reply:
  uint32_t  total_size_including_this_field
  uint8_t   result_code   // 0x00 = OK, 0xFF = FAIL
  ...return data
```

Stateless: every request gets exactly one reply. No streaming.

## Transport

- **Linux**: Unix domain socket at `$XDG_RUNTIME_DIR/pcsx2.sock.<slot>` (default slot 28011 → `pcsx2.sock.28011`)
- **macOS**: Unix domain socket at `$TMPDIR/pcsx2.sock.<slot>`
- **Windows**: TCP on `127.0.0.1:<slot>`

Default slot is **28011** (PCSX2 convention; the spec range is 28000–30000).

## Risks / unknowns

| Risk | Likelihood | Mitigation |
|---|---|---|
| Endianness not in spec | Low | Code assumes little-endian (x86/ARM); add a smoke test that reads MsgVersion first |
| PCSX2 version doesn't have PINE enabled | Low | PINE has been default-on since PCSX2 1.7.x (Qt). Document required version. |
| Default slot collisions | Low | Make port configurable via env var (same pattern as mcp-mgba) |
| Unix socket vs TCP code paths | Medium | Node's `net` module handles both transparently — just different connect args. Tested in CI matrix. |
| User has no PS2 ISO to test against | High | Need a public-domain demo / homebrew ROM for CI. Or skip integration test, mock PINE replies. |

## Architecture (mirroring mcp-mgba)

```
+----------------+    stdio     +----------------+    Unix sock   +-------------+
|   MCP client   |   JSON-RPC   |   mcp-pcsx2    |   or TCP loop  |    PCSX2    |
|  (Claude/etc)  | -----------> |   (Node.js)    | -------------> |  (PINE on)  |
+----------------+              +----------------+                +-------------+
```

## File layout (planned)

```
mcp-pcsx2/
├── src/
│   ├── index.ts         # MCP stdio entry point
│   ├── pine.ts          # PINE protocol client (sockets + framing + opcode helpers)
│   └── tools.ts         # MCP tool definitions
├── package.json
├── tsconfig.json
├── .gitignore
├── .github/workflows/ci.yml
├── README.md
├── CHANGELOG.md
└── LICENSE
```

No `lua/` directory — PINE is built into PCSX2.

## Estimated effort

| Phase | Time |
|---|---|
| Scaffolding (copy mcp-mgba structure, swap names) | 30 min |
| PINE client implementation (framing, opcodes, dual-transport socket) | 2 h |
| Tool layer (`pcsx2_*` tools — subset of mGBA's plus save/load state) | 1 h |
| Local testing against live PCSX2 (assumes PCSX2 installed + any ISO loaded) | 1.5 h |
| README, CHANGELOG, badges, npm publish | 1 h |
| **Total** | **~6 h** |

Risk-adjusted upper bound: **~8 h** if the dual-transport socket handling has Windows pipe surprises or if PCSX2 setup eats time.

For comparison, mcp-mgba took ~6 h *including* the Lua API spelunking. PCSX2 should be similar despite "skipping" the bridge layer, because the time saved by no-bridge gets eaten by cross-platform socket plumbing and a smaller-but-stranger tool surface (savestates).

## Reusable from mcp-mgba (~70%)

Direct copy with minor edits:
- `src/index.ts` shape (just rename, change default port)
- `package.json` skeleton
- `tsconfig.json` (identical)
- `.gitignore` (identical)
- `.github/workflows/ci.yml` (identical)
- `LICENSE`, `CHANGELOG.md` skeleton
- README structure

Rewrite required:
- `src/pine.ts` — different protocol than mGBA's newline-JSON RPC
- `src/tools.ts` — different tool surface
- README content (architecture diagram, install, tool table)

## Next-emulator multiplier

If we ship `mcp-pcsx2`, factoring out the shared MCP server scaffolding into a small internal package (or just a copy-paste template) makes `mcp-retroarch` and `mcp-bizhawk` each cheaper:

- mcp-retroarch (UDP network commands): ~3 h (similar shape, simpler protocol)
- mcp-bizhawk (Lua via named pipes / file IPC): ~5–6 h (Lua bridge needed, but Lua API is documented unlike mGBA)

## Open questions for the user

1. **Do you have PCSX2 1.7.x (Qt) installed and a PS2 ISO to test with?** If not, the test phase has to be mocked, which weakens the "verified end-to-end" claim.
2. **MVP scope confirmation**: ship with just memory r/w + savestate + status, no input/screenshot? Or wait until we have at least screenshot via OS hotkey injection?
3. **Naming**: stick with `mcp-pcsx2` or pick something more general like `mcp-pine` (would let it work with any PINE-speaking emulator — RPCS3, Duckstation, and a few others have adopted PINE)?
4. **Repo + npm publish at end**: same `dmang-dev` org, public repo, MIT license? (assuming yes given the mcp-mgba precedent)

## Recommendation

**Worth building.** The use cases are narrower than mGBA but real (cheat hunting and savestate automation are popular niches), the implementation effort is comparable, and the lessons-learned blog post would now have *two* concrete examples of the architecture rather than one. Cross-platform socket handling is also a useful muscle to build before tackling RetroArch (UDP) and BizHawk (named pipes).

**Caveat**: ship with honest README framing — "memory inspection + savestate automation for PS2 games" rather than "drive PS2 games with Claude." Setting the right expectation up front prevents disappointed first-impressions.
