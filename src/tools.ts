import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PineClient } from "./pine.js";
import type { TargetInfo } from "./targets.js";

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
//
// As of v0.3.0 the tool list is built dynamically from the active PINE target
// (PCSX2 / DuckStation / RPCS3 / unknown), so memory maps, address-space names,
// alignment notes, and savestate help match the emulator the user actually
// pointed mcp-pine at.
// ──────────────────────────────────────────────────────────────────────────────

function addressParamDesc(target: TargetInfo, widthBytes: number): string {
  const alignNote = widthBytes === 1
    ? "No alignment requirement for byte access."
    : `MUST be ${widthBytes}-byte aligned (address % ${widthBytes} === 0). ` + target.alignmentNote;
  return (
    `Absolute byte address in the ${target.addressSpaceName} (NOT a per-domain offset). Pass as a number; ` +
    `hex literals like 0x00200000 are fine. Reads ${widthBytes} consecutive byte` +
    `${widthBytes === 1 ? "" : "s"} starting here. ${alignNote} ` +
    `Useful range: ${target.usefulRangeHint}. ` +
    `An unmapped or invalid address returns a PINE FAIL response.`
  );
}

function slotParamDesc(target: TargetInfo): string {
  return (
    `Save state slot number (0-255). The PINE protocol accepts the full 0-255 range. ` +
    target.savestateInfo +
    ` Slot numbers are independent of any path.`
  );
}

function buildTools(target: TargetInfo): Tool[] {
  const MEM = target.memoryMap;
  const ADDR_SPACE = target.addressSpaceName;
  const EMU_NAME = target.displayName;
  const SYSTEM   = target.system;

  return [
    // ── Connectivity & introspection ────────────────────────────────────────

    {
      name: "pine_ping",
      description:
        `PURPOSE: Verify the PINE server (${EMU_NAME}) is reachable and responding. ` +
        "USAGE: Call once at session start before other tool calls. Issues PINE Version opcode (0x08) — doubles as liveness probe and emulator-version sniff. " +
        `BEHAVIOR: No side effects. Bridge connects on demand — Unix socket at $XDG_RUNTIME_DIR/${target.name}.sock.<slot> (Linux/macOS, with $TMPDIR/$/tmp fallback) or TCP to 127.0.0.1:<slot> (Windows, default slot ${target.defaultSlot}). 10-second timeout if the emulator isn't running, PINE isn't enabled (${target.setupHelp}), or slot/port mismatches. ` +
        `RETURNS: 'OK — emulator: VERSION_STRING', e.g. 'OK — emulator: ${EMU_NAME} <version>'.`,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pine_get_info",
      description:
        "PURPOSE: Get the loaded game's metadata — title, serial code, disc CRC, in-game version string — plus the current emulator run state in one call. " +
        "USAGE: Call after pine_ping to confirm what game is loaded (don't poke memory blindly — the same address means different things across games). For just the run state without the metadata round-trips use pine_get_status (1 PINE call vs 5 here). The serial (e.g. 'SLUS-21274' for PS2, 'SLUS-00067' for PS1) uniquely identifies the disc release region; combine with disc CRC to identify a specific revision. " +
        "BEHAVIOR: No side effects — pure read of emulator metadata. Issues five PINE opcodes in parallel (Title, ID, UUID, GameVersion, Status). Any individual field that the emulator doesn't expose or that fails is replaced with the literal string '(unavailable)' and the rest still come back. If the entire connection fails the call propagates an error. " +
        "RETURNS: Multi-line text with Title, Serial, Disc CRC, Game version, and Status — one field per line.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pine_get_status",
      description:
        "PURPOSE: Get the emulator run state — 'running', 'paused', 'shutdown', or 'unknown'. " +
        "USAGE: Cheap (1 PINE round-trip) check before timing-sensitive sequences — writes work while paused but only take visible effect after unpause. For game metadata (title, serial, CRC) use pine_get_info (batches Status with Title/ID/UUID/GameVersion). PINE has no pause/resume opcode; this tool only reports state. " +
        "BEHAVIOR: No side effects. Issues PINE Status opcode (0x0F), decodes the 32-bit response (0=running, 1=paused, 2=shutdown). Errors on connection failure or PINE FAIL. " +
        "RETURNS: 'Status: STATE' where STATE ∈ {running, paused, shutdown, unknown}.",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Memory reads ────────────────────────────────────────────────────────

    {
      name: "pine_read8",
      description:
        `PURPOSE: Read an unsigned 8-bit byte from the emulator's ${ADDR_SPACE} at the given absolute address. ` +
        "USAGE: Use for single-byte fields — status flags, counters, 8-bit enums, character bytes. For 16/32/64-bit values use pine_read16/read32/read64 (one call instead of multi-byte assembly); for spans of more than ~4 bytes use pine_read_range (one batched call instead of N round-trips). " +
        "BEHAVIOR: No side effects — pure read. Reads work whether the emulator is running or paused. No alignment requirement (byte access is naturally aligned). Returns an error if the address is unmapped, the connection drops, or PINE returns its FAIL response (0xFF). The 10-second per-call timeout fires if the emulator drops the reply (PCSX2 has been observed to do this under heavy pipeline load — see pine_read_range for the wider context).\n\n" +
        MEM + "\n\n" +
        "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)', e.g. '0x00200000: 99 (0x63)'.",
      inputSchema: {
        type: "object",
        required: ["address"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 1) },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pine_read16",
      description:
        `PURPOSE: Read an unsigned 16-bit little-endian value from the emulator's ${ADDR_SPACE} at the given absolute address. ` +
        `USAGE: Use for 16-bit fields (HP, score, coordinates on many ${SYSTEM} titles). For single bytes use pine_read8; for 32/64-bit use pine_read32/read64; for unaligned reads or big-endian fields, use pine_read_range and decode the bytes yourself (this tool always interprets bytes as little-endian, which matches MIPS byte order on PS1/PS2). ` +
        "BEHAVIOR: No side effects — pure read. Reads two consecutive bytes (low byte at `address`, high byte at `address+1`) and combines them as little-endian. Address MUST be 2-byte aligned. " + target.alignmentNote + " Returns a PINE FAIL response on unmapped addresses; times out after ~10s if the reply is dropped.\n\n" +
        MEM + "\n\n" +
        "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
      inputSchema: {
        type: "object",
        required: ["address"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 2) },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pine_read32",
      description:
        `PURPOSE: Read an unsigned 32-bit little-endian value from the emulator's ${ADDR_SPACE} at the given absolute address. ` +
        "USAGE: Use for 32-bit fields — timestamps, large counters, RGBA colors, and the lower half of 64-bit pointers. For single byte / 16-bit / 64-bit values use pine_read8/read16/read64; for big-endian or unaligned multi-word reads use pine_read_range and decode yourself. " +
        "BEHAVIOR: No side effects — pure read. Reads four consecutive bytes starting at `address` and combines them as little-endian (LSB at `address`, MSB at `address+3`). Address MUST be 4-byte aligned. " + target.alignmentNote + " Returns a PINE FAIL response on unmapped addresses; times out after ~10s if the reply is dropped.\n\n" +
        MEM + "\n\n" +
        "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
      inputSchema: {
        type: "object",
        required: ["address"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 4) },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pine_read64",
      description:
        `PURPOSE: Read an unsigned 64-bit little-endian value from the emulator's ${ADDR_SPACE} at the given absolute address. ` +
        "USAGE: Use for true 64-bit fields — full pointers, large IDs, packed double-word state. The PS2 EE is a 128-bit MIPS where 64-bit slots are common; PS1 and PS3 use 64-bit less heavily but the opcode still works. Reach for this rather than chaining two pine_read32 calls when you want atomicity. For 8/16/32-bit values use the corresponding sibling; for byte spans use pine_read_range. " +
        "BEHAVIOR: No side effects — pure read. Reads eight consecutive bytes starting at `address` and combines them as little-endian. Address MUST be 8-byte aligned. " + target.alignmentNote + " The result is returned as a decimal STRING (not a JSON number) to preserve precision past 2^53 (JavaScript number limit) — parse with BigInt if you need to do arithmetic. Returns a PINE FAIL response on unmapped addresses; times out after ~10s if the reply is dropped.\n\n" +
        MEM + "\n\n" +
        "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)' — VAL_DEC is a decimal string that may exceed 2^53.",
      inputSchema: {
        type: "object",
        required: ["address"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 8) },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pine_read_range",
      description:
        `PURPOSE: Read a contiguous range of bytes from ${ADDR_SPACE} memory as a hex dump. ` +
        "USAGE: For >4 bytes — far cheaper than looping pine_read8. Max 4096 bytes/call; chunk larger reads in 4 KiB. Powers snapshot-diff RAM hunts (snapshot before/after a known change, diff for matching deltas), unknown-struct inspection, and region capture/restore. " +
        "BEHAVIOR: No side effects. PINE has no native bulk-read opcode; the tool synthesizes the range from read64/32/16/8 calls (largest aligned load at each step) and assembles client-side. Issued FULLY SERIALLY by default because PCSX2's PINE queue silently drops replies past ~7 in-flight requests, desyncing the bridge until emulator restart. Loopback serial is fast enough (~52 ms for 4096 bytes on PCSX2 v2.6.3); other targets are typically similar or faster. Override via PINE_PIPELINE_BATCH env var at your own risk. Errors on length out of 1-4096, any underlying FAIL, or reply timeout.\n\n" +
        MEM + "\n\n" +
        "RETURNS: 'ADDR_HEX [N bytes]:' header + space-separated 2-digit uppercase hex bytes.",
      inputSchema: {
        type: "object",
        required: ["address", "length"],
        properties: {
          address: {
            type: "integer",
            minimum: 0,
            description:
              `Starting absolute byte address in the ${ADDR_SPACE}. Bytes [address, address+length) are read. ` +
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
        `PURPOSE: Write a single unsigned byte (0-255) to the emulator's ${ADDR_SPACE} at the given absolute address. ` +
        "USAGE: Use for single-byte cheats, debug pokes, and game-state mutations (give a player N lives, unlock a flag, set a counter). For 16/32/64-bit values prefer pine_write16/write32/write64 (single call instead of byte-at-a-time, and atomic from the emulator's perspective). For seeding many bytes there is no native bulk write — loop pine_write8 yourself or batch via pine_write64 on aligned regions. To roll back later use pine_save_state BEFORE the write and pine_load_state to restore. " +
        "BEHAVIOR: DESTRUCTIVE: overwrites whatever was at `address` with no undo. The write is direct memory access — bypasses TLB protection and any DMA semantics — so writes to read-only regions (BIOS, etc.) are silently dropped by the emulator with no error. The write takes effect immediately, but visible game-state effects only appear when the emulator next ticks (so writing while paused shows changes only after unpause or frame-step). No alignment requirement for byte access. Returns an error if the connection drops or PINE returns FAIL on a wholly invalid address.\n\n" +
        MEM + "\n\n" +
        "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
      inputSchema: {
        type: "object",
        required: ["address", "value"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 1) },
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
        `PURPOSE: Write an unsigned 16-bit little-endian value to ${ADDR_SPACE}. ` +
        "USAGE: For 16-bit cheats/pokes (HP, score, coordinates). For single bytes use pine_write8; for 32/64-bit use pine_write32/write64; for big-endian fields byteswap first (this tool always writes little-endian). Snapshot via pine_save_state for rollback. " +
        "BEHAVIOR: DESTRUCTIVE: overwrites two bytes (low at `address`, high at `address+1`) with no undo. Direct write — bypasses TLB; writes to read-only regions (BIOS) are silently dropped. Address MUST be 2-byte aligned. " + target.alignmentNote + " Errors on connection drop or PINE FAIL.\n\n" +
        MEM + "\n\n" +
        "RETURNS: 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
      inputSchema: {
        type: "object",
        required: ["address", "value"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 2) },
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
        `PURPOSE: Write an unsigned 32-bit little-endian value to the emulator's ${ADDR_SPACE} at the given absolute address. ` +
        "USAGE: Use for 32-bit cheats and pokes — timestamps, large counters, RGBA colors, the lower half of pointers. For single byte / 16-bit values use pine_write8/write16; for true 64-bit fields use pine_write64 — chaining two pine_write32 calls is non-atomic and can be observed mid-update by the running game. For big-endian layouts, byteswap into a little-endian value yourself first. " +
        "BEHAVIOR: DESTRUCTIVE: overwrites four bytes starting at `address` with no undo. Direct memory write — bypasses TLB protection and DMA mediation; writes to read-only regions (BIOS) are silently dropped with no error. Address MUST be 4-byte aligned. " + target.alignmentNote + " Values are NOT truncated by this tool: the schema rejects anything outside 0-4294967295 (0x00000000-0xFFFFFFFF) before the call ever reaches PINE. Returns an error if the connection drops or PINE returns FAIL on a wholly invalid address.\n\n" +
        MEM + "\n\n" +
        "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
      inputSchema: {
        type: "object",
        required: ["address", "value"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 4) },
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
        `PURPOSE: Write an unsigned 64-bit little-endian value to ${ADDR_SPACE}. ` +
        "USAGE: For true 64-bit writes — full pointers, large IDs, packed doubleword state. Atomic from the emulator's perspective; preferred over chaining two pine_write32 calls (a running game can observe the in-between state). For 8/16/32-bit values use the corresponding sibling. " +
        "BEHAVIOR: DESTRUCTIVE: overwrites eight bytes from `address` with no undo. Direct write — bypasses TLB; writes to read-only regions silently dropped. Address MUST be 8-byte aligned. " + target.alignmentNote + " `value` is a DECIMAL STRING (0 through 18446744073709551615) to preserve precision past JS's 2^53 number limit. Errors on connection drop or PINE FAIL.\n\n" +
        MEM + "\n\n" +
        "RETURNS: 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX' — VAL_DEC may exceed 2^53.",
      inputSchema: {
        type: "object",
        required: ["address", "value"],
        properties: {
          address: { type: "integer", minimum: 0, description: addressParamDesc(target, 8) },
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
        "PURPOSE: Trigger the emulator to save complete state (RAM, registers, GPU, audio, timing) to a numbered slot. " +
        `USAGE: Rollback point before risky writes, bookmarks, repro sharing. Companion pine_load_state restores from the same slot. PINE savestates are SLOT-BASED (0-255), not file-path-based — ${EMU_NAME} picks the disk location. ` +
        `BEHAVIOR: DESTRUCTIVE TO TARGET SLOT: silently overwrites prior contents — no prompt, no backup, no recovery. Bound to the exact game disc and ${EMU_NAME} version; loading mismatched usually crashes the core. The call returns when ${EMU_NAME} schedules the save, NOT when the file is on disk — brief half-written window possible. Errors on no game loaded, unwritable folder, or PINE FAIL.\n\n` +
        "RETURNS: 'Save state triggered for slot N'.",
      inputSchema: {
        type: "object",
        required: ["slot"],
        properties: {
          slot: { type: "integer", minimum: 0, maximum: 255, description: slotParamDesc(target) },
        },
        additionalProperties: false,
      },
    },
    {
      name: "pine_load_state",
      description:
        "PURPOSE: Trigger the emulator to load a previously-saved state from the given numbered savestate slot, replacing all live state. " +
        "USAGE: Counterpart to pine_save_state. Use to undo a sequence of writes/inputs (the snapshot/experiment/restore workflow), to jump to a bookmarked game state, or to start each tool-call sequence from a known baseline. There is no PINE 'reset' opcode — to start fresh from boot you must use the emulator's GUI or pre-prepare a slot containing a freshly booted state. " +
        `BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces ALL current emulator state (RAM, registers, GPU, audio, etc.) with the contents of the slot's file. Anything not previously snapshotted is lost permanently. The state file MUST come from the same game disc and same ${EMU_NAME} version that produced it; loading an incompatible state typically crashes the core (no recovery without restarting ${EMU_NAME}). The PINE call returns immediately after ${EMU_NAME} schedules the load, NOT after the load is fully visible — there can be a brief window where state is partially loaded. Returns an error if the slot file doesn't exist, the file is corrupt or for the wrong game, or PINE returns FAIL.\n\n` +
        "RETURNS: Single line 'Load state triggered for slot N'.",
      inputSchema: {
        type: "object",
        required: ["slot"],
        properties: {
          slot: { type: "integer", minimum: 0, maximum: 255, description: slotParamDesc(target) },
        },
        additionalProperties: false,
      },
    },
  ];
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fmtHex(n: number | bigint): string {
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}

function addrHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

export function registerTools(server: Server, pine: PineClient, target: TargetInfo): void {
  const TOOLS = buildTools(target);
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
