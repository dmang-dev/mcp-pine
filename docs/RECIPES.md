# mcp-pine recipes

Practical examples of driving a PINE-speaking emulator (PCSX2 et al.) through Claude or any MCP client. Each recipe is self-contained.

> Prerequisites: emulator running with PINE enabled (PCSX2: Settings > Advanced > Enable PINE Server, default slot 28011), a game loaded. Test with `pine_ping` first.

---

## 1. Find the address of a counter you can see on screen

> "I'm running a PS2 game with a 4-digit score in the HUD reading 1234. The score increased to 1300. Find the address."

The pattern: take memory snapshots before and after a known change, diff for u32/u16 values that went `1234 → 1300`. PS2 game data lives in EE main RAM (`0x00000000`–`0x01FFFFFF`, 32 MiB). Sweeping all of it would be 8192 read_range calls of 4 KiB each (slow over PINE), so narrow the range with intuition first — most game state lives in the first 4 MiB.

```
1. pine_read_range(address=0x00100000, length=4096)   # snapshot A
2. <user advances the in-game score>
3. pine_read_range(address=0x00100000, length=4096)   # snapshot B
4. <Claude diffs A vs B for u32 that changed 1234 → 1300>
```

If no hit in `0x00100000`, walk forward by 4 KiB and repeat.

---

## 2. Inject a value into a known address

> "The lives counter for this game is at EE address 0x00ABCDEF. Set it to 99."

```
pine_write32(address=0x00ABCDEF, value=99)
```

Or for a single byte: `pine_write8`. Or for a 64-bit value: pass the value as a decimal string (PS2 EE has 64-bit GPRs).

---

## 3. Snapshot, experiment, restore

> "Save state to slot 0, mess with memory, restore."

```
pine_save_state(slot=0)
# experiment freely
pine_load_state(slot=0)
```

PCSX2 has 10 slots (0-9). Save state is async on PCSX2's side — the PINE call returns "command accepted" immediately, but the actual file may take a moment to land. For a deterministic capture, wait briefly between save and any dependent operation.

---

## 4. Read a struct from memory

> "There's a Player struct at EE 0x00ABCDE0. It's 32 bytes: u32 hp, u32 max_hp, u32 mp, u32 max_mp, u8 level, u8 status, u16 padding, ... Read and decode it."

```
pine_read_range(address=0x00ABCDE0, length=32)
```

Returns a 32-byte array. Decode little-endian:

```
hp      = bytes[0..3]   as u32 LE
max_hp  = bytes[4..7]   as u32 LE
mp      = bytes[8..11]  as u32 LE
max_mp  = bytes[12..15] as u32 LE
level   = bytes[16]
status  = bytes[17]
...
```

---

## 5. Watch a counter tick across save-state restore

> "Save state, advance 100 frames worth of game time (just wait), then restore. Confirm the counter at 0x00100000 is back to its original value."

```
v_before = pine_read32(address=0x00100000)
pine_save_state(slot=5)
# wait 2 real-world seconds
v_after_wait = pine_read32(address=0x00100000)   # changed
pine_load_state(slot=5)
v_restored = pine_read32(address=0x00100000)     # should equal v_before
```

If `v_restored != v_before`, the address you're watching is being touched by something outside the save-state's purview (e.g. a hardware register that doesn't get serialized).

---

## 6. Identify the loaded game

> "What's running?"

```
pine_get_info
```

Returns title, serial (e.g. `SLUS-21274`), disc CRC (32-bit hex), game version from ELF, and emulator status. The serial is the canonical identifier — useful for cross-referencing community cheat databases or speedrun resources.

---

## 7. Sanity-check the bridge

```
pine_ping        # returns "OK — emulator: PCSX2 v2.6.x"
```

If it fails, see README troubleshooting — most likely PINE isn't enabled in Settings or the slot doesn't match `PINE_SLOT`.

---

## What this server can NOT do (because PINE doesn't expose it)

- **Send controller input** — no PINE opcode for it. For input automation, you need OS-level keypress injection (out of scope).
- **Take screenshots** — same reason. PCSX2's F8 hotkey can be triggered via OS automation as a workaround.
- **Step / pause / reset** — PINE only exposes `getStatus` (running/paused/shutdown), not control.
- **Bulk memory writes** — only single-value writes per PINE call. For seeding a large region, loop your writes.

If you need input + screenshot for an emulator MCP, see [mcp-mgba](https://github.com/dmang-dev/mcp-mgba) (Game Boy Advance, with full input/screenshot via Lua bridge).

---

## Tips for using these tools

- **Pin the EE main RAM range.** PS2 games live almost entirely in `0x00000000`–`0x01FFFFFF` (EE main RAM, 32 MiB). Other regions (IOP, GS, scratchpads) are rarely useful for game-state work.
- **Save state is the killer feature.** When you don't have input/screenshot, snapshot-and-restore-around-experiments is how you keep iterating fast.
- **For 64-bit values, use strings end-to-end.** The MCP tool transports `value` as a string for `pine_write64` to preserve precision past `2^53`.
