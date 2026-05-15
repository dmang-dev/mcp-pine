import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PineClient } from "./pine.js";

const PS2_REGIONS = `
PlayStation 2 main address space landmarks (PCSX2):
  0x00100000-0x01FFFFFF  EE main RAM (32 MiB) — game code & data; the most common target
  0x10000000             Hardware registers (DMA, GIF, VIF, etc.)
  0x11000000             VU0 / VU1 memory
  0x12000000             GS privileged registers
  0x1C000000-0x1C1FFFFF  IOP RAM (2 MiB)
  0x1F800000             IOP scratchpad
  0x70000000             EE scratchpad (16 KiB)
PINE memory operations target the EE address space. Other PINE-protocol
emulators (RPCS3, Duckstation) use entirely different maps — consult their docs.`.trim();

// ──────────────────────────────────────────────────────────────────────────────
// Tool descriptions are written to the TDQS rubric (Glama's Tool Definition
// Quality Score). Each description covers, in order:
//
//   • PURPOSE — one clear action sentence.
//   • USAGE — when to use this vs sibling tools (read8 vs read16/32/64 vs
//     read_range, write* vs save_state, get_status vs get_info, etc.).
//   • BEHAVIOR — side effects, error conditions, destructive notes. Reads say
//     "no side effects — pure read." Writes say "DESTRUCTIVE: overwrites".
//     Every tool documents the failure modes it can return (FAIL response,
//     timeout, alignment garbage, dropped pipeline, etc.).
//   • RETURNS — exact shape of the success output.
//
// Each parameter has a `description` that adds context the schema can't
// (units, alignment requirements, value-encoding rules, examples).
// ──────────────────────────────────────────────────────────────────────────────

const ADDRESS_PARAM_DESC = (widthBytes: number) => {
  const alignNote = widthBytes === 1
    ? "No alignment requirement for byte access."
    : `MUST be ${widthBytes}-byte aligned (address % ${widthBytes} === 0). PINE on PCSX2 does NOT enforce ` +
      `alignment — unaligned ${widthBytes * 8}-bit access typically returns whatever bytes are at the ` +
      `aligned address below, silently corrupting the value. If you need an unaligned multi-byte read, ` +
      `use pine_read_range and assemble the bytes yourself.`;
  return (
    `Absolute byte address in the EE main address space (NOT a per-domain offset). Pass as a number; ` +
    `hex literals like 0x00200000 are fine. Reads ${widthBytes} consecutive byte` +
    `${widthBytes === 1 ? "" : "s"} starting here. ${alignNote} ` +
    `Useful range: 0x00100000-0x01FFFFFF for EE main RAM (where 99% of game state lives). ` +
    `An unmapped or invalid address returns a PINE FAIL response.`
  );
};

const SLOT_PARAM_DESC =
  "Save state slot number (0-255). PCSX2 conventionally uses slots 0-9 (mapped to F1-F10 in the GUI), " +
  "but the PINE protocol accepts the full 0-255 range. Slot files live in PCSX2's per-game savestate " +
  "folder (typically %USERPROFILE%/Documents/PCSX2/sstates on Windows, ~/.config/PCSX2/sstates on Linux) " +
  "with filenames like '<serial> (<crc>).<slot>.p2s'. Slot numbers are independent of any path.";

const TOOLS: Tool[] = [
  // ── Connectivity & introspection ────────────────────────────────────────

  {
    name: "pine_ping",
    description:
      "PURPOSE: Verify that the PINE server (PCSX2 or another PINE-compatible emulator) is reachable and responding to RPC over its socket. " +
      "USAGE: Call this once at start-of-session before issuing other tool calls; if it succeeds, every other tool will work for the live emulator instance. Internally issues the PINE Version opcode (0x08) — a cheap round-trip that doubles as a liveness probe and an emulator-version sniff. " +
      "BEHAVIOR: No side effects — pure liveness probe. The bridge connects on demand: on Linux/macOS it opens a Unix domain socket at $XDG_RUNTIME_DIR/<target>.sock.<slot> (or $TMPDIR / /tmp fallback), on Windows it opens TCP to 127.0.0.1:<slot> (default port 28011 for PCSX2). Times out after ~10 seconds with a clear error if the emulator isn't running, PINE isn't enabled (PCSX2: Settings > Advanced > Enable PINE Server), or the slot/port doesn't match. " +
      "RETURNS: Single line 'OK — emulator: VERSION_STRING' (e.g. 'OK — emulator: PCSX2 2.6.3').",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pine_get_info",
    description:
      "PURPOSE: Get the loaded game's metadata — title, serial code, disc CRC, in-game version string — plus the current emulator run state in one call. " +
      "USAGE: Call after pine_ping to confirm what game is loaded (don't poke memory blindly — the same address means different things across games). For just the run state without the metadata round-trips use pine_get_status (1 PINE call vs 5 here). The serial (e.g. 'SLUS-21274') uniquely identifies the disc release region; combine with disc CRC to identify a specific revision. " +
      "BEHAVIOR: No side effects — pure read of emulator metadata. Issues five PINE opcodes in parallel (Title, ID, UUID, GameVersion, Status). Any individual field that the emulator doesn't expose or that fails is replaced with the literal string '(unavailable)' and the rest still come back. If the entire connection fails the call propagates an error. " +
      "RETURNS: Multi-line text with Title, Serial, Disc CRC, Game version, and Status — one field per line.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pine_get_status",
    description:
      "PURPOSE: Get just the emulator run state — 'running', 'paused', 'shutdown', or 'unknown'. " +
      "USAGE: Use as a cheap (single PINE round-trip) check before timing-sensitive sequences — e.g. before a sequence of memory writes you may want to confirm the emulator isn't paused (writes still work but won't take visible effect until unpaused). For game metadata (title, serial, CRC) use pine_get_info instead — that batches Status with Title/ID/UUID/GameVersion. PINE itself has no pause/resume opcode, so this tool only reports state; pause from the emulator UI or via a separate hotkey. " +
      "BEHAVIOR: No side effects — pure read. Issues PINE Status opcode (0x0F) and decodes the 32-bit response (0=running, 1=paused, 2=shutdown, anything else='unknown'). Returns an error if the connection fails or PINE returns FAIL. " +
      "RETURNS: Single line 'Status: STATE' where STATE is one of 'running', 'paused', 'shutdown', 'unknown'.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Memory reads ────────────────────────────────────────────────────────

  {
    name: "pine_read8",
    description:
      "PURPOSE: Read an unsigned 8-bit byte from the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for single-byte fields — status flags, counters, 8-bit enums, character bytes. For 16/32/64-bit values use pine_read16/read32/read64 (one call instead of multi-byte assembly); for spans of more than ~4 bytes use pine_read_range (one batched call instead of N round-trips). For PS2 game-state pointers and 64-bit IDs prefer pine_read64 (PS2's EE is a 128-bit MIPS — 64-bit fields are common). " +
      "BEHAVIOR: No side effects — pure read. Reads work whether the emulator is running or paused. No alignment requirement (byte access is naturally aligned). Returns an error if the address is unmapped, the connection drops, or PINE returns its FAIL response (0xFF). The 10-second per-call timeout fires if the emulator drops the reply (PCSX2 has been observed to do this under heavy pipeline load — see pine_read_range for the wider context).\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)', e.g. '0x00200000: 99 (0x63)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(1) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_read16",
    description:
      "PURPOSE: Read an unsigned 16-bit little-endian value from the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for 16-bit fields (HP, score, coordinates on many PS2 titles). For single bytes use pine_read8; for 32/64-bit use pine_read32/read64; for unaligned reads or big-endian fields, use pine_read_range and decode the bytes yourself (this tool always interprets bytes as little-endian, which matches PS2's native EE byte order). " +
      "BEHAVIOR: No side effects — pure read. Reads two consecutive bytes (low byte at `address`, high byte at `address+1`) and combines them as little-endian. Address MUST be 2-byte aligned — PINE silently aligns down on PCSX2, returning corrupted data instead of an error if you pass an odd address. Returns a PINE FAIL response on unmapped addresses; times out after ~10s if the reply is dropped.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(2) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_read32",
    description:
      "PURPOSE: Read an unsigned 32-bit little-endian value from the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for 32-bit fields — timestamps, large counters, RGBA colors, and the lower half of 64-bit pointers. For single byte / 16-bit / 64-bit values use pine_read8/read16/read64; for big-endian or unaligned multi-word reads use pine_read_range and decode yourself. PS2 EE pointers are technically 64-bit but the upper bits are usually zero — many tools treat them as 32-bit, in which case this is the right call. " +
      "BEHAVIOR: No side effects — pure read. Reads four consecutive bytes starting at `address` and combines them as little-endian (LSB at `address`, MSB at `address+3`). Address MUST be 4-byte aligned — PINE on PCSX2 does not enforce this; an unaligned address silently returns corrupted data. Returns a PINE FAIL response on unmapped addresses; times out after ~10s if the reply is dropped.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(4) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_read64",
    description:
      "PURPOSE: Read an unsigned 64-bit little-endian value from the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for true 64-bit fields — full PS2 EE pointers, large IDs, packed double-word state. The PS2 EE is a 128-bit MIPS (Emotion Engine), and a lot of game state genuinely lives in 64-bit slots; reach for this rather than chaining two pine_read32 calls. For 8/16/32-bit values use the corresponding sibling; for byte spans use pine_read_range. " +
      "BEHAVIOR: No side effects — pure read. Reads eight consecutive bytes starting at `address` and combines them as little-endian. Address MUST be 8-byte aligned — PINE on PCSX2 does not enforce this; unaligned addresses silently return corrupted data. The result is returned as a decimal STRING (not a JSON number) to preserve precision past 2^53 (JavaScript number limit) — parse with BigInt if you need to do arithmetic. Returns a PINE FAIL response on unmapped addresses; times out after ~10s if the reply is dropped.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)' — VAL_DEC is a decimal string that may exceed 2^53.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(8) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_read_range",
    description:
      "PURPOSE: Read a contiguous range of bytes from the emulator's EE address space and return them as a hex-formatted dump. " +
      "USAGE: Use whenever you need more than ~4 bytes — far cheaper than looping pine_read8 since this tool batches the work into the largest aligned loads available (read64 on 8-byte boundaries, falling back to 32/16/8 at the unaligned edges). Hard cap of 4096 bytes per call; for larger reads, batch in 4 KiB chunks yourself. Classic uses: snapshot-diff RAM hunts (snapshot before a known game change, snapshot after, diff for matching deltas), inspecting unknown structs, capturing a region for later restore via cheats. " +
      "BEHAVIOR: No side effects — pure read. PINE has NO native bulk-read opcode; this tool synthesizes the range by issuing a sequence of read64/32/16/8 calls and assembling the bytes client-side. By default it issues these calls FULLY SERIALLY (one in flight at a time) because PCSX2's PINE server has a fragile request queue — at as few as ~7 mixed in-flight requests it silently drops replies, which leaves the bridge's reply pipeline desynced and times out ALL subsequent calls until the emulator is restarted. Loopback is fast enough that serial is OK (~52 ms for 4096 bytes against PCSX2 v2.6.3). The PINE_PIPELINE_BATCH env var can raise the in-flight count if you trust your specific emulator's PINE implementation. Returns an error if length < 1 or > 4096, if any underlying read FAILs, or if a reply times out.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Header line 'ADDR_HEX [N bytes]:' followed by space-separated 2-digit uppercase hex bytes.",
    inputSchema: {
      type: "object",
      required: ["address", "length"],
      properties: {
        address: {
          type: "integer",
          minimum: 0,
          description:
            "Starting absolute byte address in the EE address space. Bytes [address, address+length) are read. " +
            "No alignment requirement — the tool picks the largest aligned load it can at each step (e.g. an unaligned start, " +
            "an aligned middle, and an unaligned tail are handled in three different load widths)."
        },
        length: {
          type: "integer",
          minimum: 1,
          maximum: 4096,
          description:
            "Number of consecutive bytes to read (1-4096). Hard cap is the tool's max; chunk larger reads yourself. " +
            "Latency is roughly proportional to length / 8 in serial mode (the default) — a 4096-byte read is ~512 PINE round-trips on a typical 8-byte-aligned region, around 50 ms over loopback."
        },
      },
      additionalProperties: false,
    },
  },

  // ── Memory writes ───────────────────────────────────────────────────────

  {
    name: "pine_write8",
    description:
      "PURPOSE: Write a single unsigned byte (0-255) to the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for single-byte cheats, debug pokes, and game-state mutations (give a player N lives, unlock a flag, set a counter). For 16/32/64-bit values prefer pine_write16/write32/write64 (single call instead of byte-at-a-time, and atomic from the emulator's perspective). For seeding many bytes there is no native bulk write — loop pine_write8 yourself or batch via pine_write64 on aligned regions. To roll back later use pine_save_state BEFORE the write and pine_load_state to restore. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites whatever was at `address` with no undo. The write is direct memory access — bypasses TLB protection and any DMA semantics — so writes to read-only regions (BIOS, IOP ROM, etc.) are silently dropped by PCSX2 with no error. The write takes effect immediately, but visible game-state effects only appear when the emulator next ticks (so writing while paused shows changes only after unpause or frame-step). No alignment requirement for byte access. Returns an error if the connection drops or PINE returns FAIL on a wholly invalid address.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(1) },
        value: {
          type: "integer",
          minimum: 0,
          maximum: 255,
          description: "Byte value to write. Must be 0-255 (0x00-0xFF). Values outside this range are rejected by the schema."
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_write16",
    description:
      "PURPOSE: Write an unsigned 16-bit little-endian value to the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for 16-bit cheats and pokes (HP, score, coordinates). For single bytes use pine_write8; for 32/64-bit use pine_write32/write64; for big-endian fields, byteswap into a value with the bytes reversed yourself before calling — this tool always writes little-endian. To roll back, snapshot first via pine_save_state. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites two bytes (low byte at `address`, high byte at `address+1`) with no undo. Direct memory write — bypasses TLB protection; writes to read-only regions are silently dropped. Address MUST be 2-byte aligned — PINE on PCSX2 does NOT enforce this; an unaligned address writes the bytes at the aligned address below, silently corrupting unrelated state. Returns an error if the connection drops or PINE returns FAIL on a wholly invalid address.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(2) },
        value: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description:
            "16-bit value to write. Must be 0-65535 (0x0000-0xFFFF). LSB lands at `address`, MSB at `address+1`. " +
            "For signed 16-bit values, encode as two's complement (e.g. -1 → 0xFFFF). Values outside the range are rejected by the schema."
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_write32",
    description:
      "PURPOSE: Write an unsigned 32-bit little-endian value to the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for 32-bit cheats and pokes — timestamps, large counters, RGBA colors, the lower half of pointers. For single byte / 16-bit values use pine_write8/write16; for true 64-bit fields (full EE pointers, large IDs) use pine_write64 — chaining two pine_write32 calls is non-atomic and can be observed mid-update by the running game. For big-endian layouts, byteswap into a little-endian value yourself first. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites four bytes starting at `address` with no undo. Direct memory write — bypasses TLB protection and DMA mediation; writes to read-only regions (BIOS, IOP ROM) are silently dropped with no error. Address MUST be 4-byte aligned — PINE on PCSX2 does NOT enforce this; an unaligned address silently corrupts the bytes at the aligned address below, NOT what you asked for, and supplies no error. Values are NOT truncated by this tool: the schema rejects anything outside 0-4294967295 (0x00000000-0xFFFFFFFF) before the call ever reaches PINE. Returns an error if the connection drops or PINE returns FAIL on a wholly invalid address.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(4) },
        value: {
          type: "integer",
          minimum: 0,
          maximum: 4294967295,
          description:
            "32-bit value to write. Must be 0-4294967295 (0x00000000-0xFFFFFFFF). LSB lands at `address`, MSB at `address+3`. " +
            "For signed 32-bit values, encode as two's complement (e.g. -1 → 0xFFFFFFFF). For floats, reinterpret the IEEE-754 bits as an integer first. " +
            "Values outside the range are rejected by the schema, NOT silently truncated — pass the value you actually want stored."
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_write64",
    description:
      "PURPOSE: Write an unsigned 64-bit little-endian value to the emulator's EE address space at the given absolute address. " +
      "USAGE: Use for true 64-bit writes — full PS2 EE pointers, large IDs, packed doubleword state. Single atomic write from the emulator's perspective; preferred over chaining two pine_write32 calls when atomicity matters (a running game can observe the in-between state with the chained approach). For 8/16/32-bit values use the corresponding sibling. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites eight bytes starting at `address` with no undo. Direct memory write — bypasses TLB protection; writes to read-only regions are silently dropped. Address MUST be 8-byte aligned — PINE on PCSX2 does NOT enforce this; an unaligned address silently corrupts unrelated bytes. The `value` is passed as a DECIMAL STRING (not a JSON number) to preserve precision past 2^53 (JavaScript number limit) — pass '0' through '18446744073709551615' as a string, e.g. \"4294967296\". Strings that don't match ^[0-9]+$ are rejected by the schema. Returns an error if the connection drops or PINE returns FAIL on a wholly invalid address.\n\n" +
      PS2_REGIONS + "\n\n" +
      "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX' — VAL_DEC may exceed 2^53.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(8) },
        value: {
          type: "string",
          pattern: "^[0-9]+$",
          description:
            "64-bit value to write, as a non-negative DECIMAL STRING (digits only, no '0x' prefix, no sign, no separators). " +
            "Range 0 through 18446744073709551615 (2^64 - 1). Example: \"18446744073709551615\" writes 0xFFFFFFFFFFFFFFFF. " +
            "Encoded as a string so values past 2^53 are preserved exactly (JSON numbers lose precision at that point). " +
            "For signed 64-bit values, encode as two's complement (e.g. -1 → \"18446744073709551615\")."
        },
      },
      additionalProperties: false,
    },
  },

  // ── Save state ─────────────────────────────────────────────────────────

  {
    name: "pine_save_state",
    description:
      "PURPOSE: Trigger the emulator to save its complete state (RAM, EE/IOP/VU registers, GS state, sound, timing) to the given numbered savestate slot. " +
      "USAGE: Use as a rollback point before risky writes, to bookmark an interesting game state, or to share a repro state with a teammate. The companion pine_load_state restores from the same slot. PINE savestates are SLOT-BASED (0-255 integer), unlike file-path-based emulator APIs (e.g. BizHawk's) — the emulator decides where on disk to put the file. PCSX2's GUI uses slots 0-9 as F1-F10; programmatic use can extend up to 255 if you don't mind being outside the GUI's range. " +
      "BEHAVIOR: DESTRUCTIVE TO TARGET SLOT: silently overwrites whatever was previously saved in that slot — no prompt, no backup, no way to recover the old state. The save is bound to the EXACT game disc and PCSX2 version that produced it; loading a slot saved against a different game or major PCSX2 version usually crashes the core. The PINE call returns immediately after PCSX2 schedules the save, NOT after the file is fully on disk — for very large states there can be a brief window where the file is half-written. Returns an error if PCSX2 has no game loaded, the savestate folder isn't writable, or PINE returns FAIL.\n\n" +
      "RETURNS: Single line 'Save state triggered for slot N'.",
    inputSchema: {
      type: "object",
      required: ["slot"],
      properties: {
        slot: { type: "integer", minimum: 0, maximum: 255, description: SLOT_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pine_load_state",
    description:
      "PURPOSE: Trigger the emulator to load a previously-saved state from the given numbered savestate slot, replacing all live state. " +
      "USAGE: Counterpart to pine_save_state. Use to undo a sequence of writes/inputs (the snapshot/experiment/restore workflow), to jump to a bookmarked game state, or to start each tool-call sequence from a known baseline. There is no PINE 'reset' opcode — to start fresh from boot you must use the emulator's GUI or pre-prepare a slot containing a freshly booted state. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces ALL current emulator state (RAM, registers, GS, audio, etc.) with the contents of the slot's file. Anything not previously snapshotted is lost permanently. The state file MUST come from the same game disc and same PCSX2 version that produced it; loading an incompatible state typically crashes the core (no recovery without restarting PCSX2). The PINE call returns immediately after PCSX2 schedules the load, NOT after the load is fully visible — there can be a brief window where state is partially loaded. Returns an error if the slot file doesn't exist, the file is corrupt or for the wrong game, or PINE returns FAIL.\n\n" +
      "RETURNS: Single line 'Load state triggered for slot N'.",
    inputSchema: {
      type: "object",
      required: ["slot"],
      properties: {
        slot: { type: "integer", minimum: 0, maximum: 255, description: SLOT_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
];

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fmtHex(n: number | bigint): string {
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}

function addrHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

export function registerTools(server: Server, pine: PineClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const p = args as Record<string, unknown>;
    const addr = () => p.address as number;

    switch (name) {
      case "pine_ping": {
        const v = await pine.getVersion();
        return ok(`OK — emulator: ${v}`);
      }

      case "pine_get_info": {
        const [title, id, uuid, gameVer, status] = await Promise.all([
          pine.getTitle().catch(() => "(unavailable)"),
          pine.getId().catch(() => "(unavailable)"),
          pine.getUuid().catch(() => "(unavailable)"),
          pine.getGameVersion().catch(() => "(unavailable)"),
          pine.getStatus(),
        ]);
        return ok(
          `Title:        ${title}\n` +
          `Serial:       ${id}\n` +
          `Disc CRC:     ${uuid}\n` +
          `Game version: ${gameVer}\n` +
          `Status:       ${status}`,
        );
      }

      case "pine_get_status": {
        return ok(`Status: ${await pine.getStatus()}`);
      }

      case "pine_read8":  return ok(`${addrHex(addr())}: ${fmtHex(await pine.read8(addr()))}`);
      case "pine_read16": return ok(`${addrHex(addr())}: ${fmtHex(await pine.read16(addr()))}`);
      case "pine_read32": return ok(`${addrHex(addr())}: ${fmtHex(await pine.read32(addr()))}`);
      case "pine_read64": return ok(`${addrHex(addr())}: ${fmtHex(await pine.read64(addr()))}`);

      case "pine_write8": {
        await pine.write8(addr(), p.value as number);
        return ok(`Wrote ${fmtHex(p.value as number)} → ${addrHex(addr())}`);
      }
      case "pine_write16": {
        await pine.write16(addr(), p.value as number);
        return ok(`Wrote ${fmtHex(p.value as number)} → ${addrHex(addr())}`);
      }
      case "pine_write32": {
        await pine.write32(addr(), p.value as number);
        return ok(`Wrote ${fmtHex(p.value as number)} → ${addrHex(addr())}`);
      }
      case "pine_write64": {
        const v = BigInt(p.value as string);
        await pine.write64(addr(), v);
        return ok(`Wrote ${fmtHex(v)} → ${addrHex(addr())}`);
      }

      case "pine_read_range": {
        const bytes = await pine.readRange(p.address as number, p.length as number);
        const hex = Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
          .join(" ");
        return ok(`${addrHex(p.address as number)} [${bytes.length} bytes]:\n${hex}`);
      }

      case "pine_save_state": {
        await pine.saveState(p.slot as number);
        return ok(`Save state triggered for slot ${p.slot}`);
      }
      case "pine_load_state": {
        await pine.loadState(p.slot as number);
        return ok(`Load state triggered for slot ${p.slot}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}
