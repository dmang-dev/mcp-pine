// PINE target configuration.
// ───────────────────────────
// mcp-pine speaks the generic PINE protocol (same opcodes, same wire format
// for all targets). What differs across targets is *context*: the memory
// map an agent should target, the address-space name, the savestate file
// layout, and the startup steps the user has to follow in each emulator.
//
// This file collects that per-target context so tools.ts and index.ts can
// render help text that's accurate for the actual emulator the user is
// pointing at, rather than blanket-PCSX2 text that's wrong on PS1.
//
// PINE_TARGET env var selects the active target at startup. Unknown values
// pass through (warn + treat as generic) so a niche/future PINE emulator
// still works on the protocol level.

export interface TargetInfo {
  /** Lowercase short name used in PINE socket file naming and PINE_TARGET env. */
  name: string;
  /** Human-readable emulator name for help text. */
  displayName: string;
  /** Console/system the emulator emulates. */
  system: string;
  /** Default PINE slot (also the TCP port on Windows). */
  defaultSlot: number;
  /** Short address-space name used in tool PURPOSE lines, e.g. "EE address space" (PCSX2), "main RAM" (DuckStation). */
  addressSpaceName: string;
  /** Useful-range hint for memory operations (single hex range string). */
  usefulRangeHint: string;
  /** Full multi-line memory map shown in memory-tool descriptions. */
  memoryMap: string;
  /** Startup help shown when PINE isn't reachable — exact menu path + port. */
  setupHelp: string;
  /** Where savestate files live + filename convention. Used by save/load slot tool descriptions. */
  savestateInfo: string;
  /** Per-tool alignment-failure note describing what THIS emulator does on unaligned access. */
  alignmentNote: string;
}

const PCSX2: TargetInfo = {
  name: "pcsx2",
  displayName: "PCSX2",
  system: "PlayStation 2",
  defaultSlot: 28011,
  addressSpaceName: "EE main address space",
  usefulRangeHint: "0x00100000-0x01FFFFFF for EE main RAM (where 99% of game state lives)",
  memoryMap: `
PlayStation 2 main address space landmarks (PCSX2):
  0x00100000-0x01FFFFFF  EE main RAM (32 MiB) — game code & data; the most common target
  0x10000000             Hardware registers (DMA, GIF, VIF, etc.)
  0x11000000             VU0 / VU1 memory
  0x12000000             GS privileged registers
  0x1C000000-0x1C1FFFFF  IOP RAM (2 MiB)
  0x1F800000             IOP scratchpad
  0x70000000             EE scratchpad (16 KiB)
PINE memory operations target the EE address space.`.trim(),
  setupHelp:
    "For PCSX2: Settings > Advanced > Enable PINE Server (default port 28011).",
  savestateInfo:
    "PCSX2 slot files live in PCSX2's per-game savestate folder (typically " +
    "%USERPROFILE%/Documents/PCSX2/sstates on Windows, ~/.config/PCSX2/sstates on Linux) " +
    "with filenames like '<serial> (<crc>).<slot>.p2s'.",
  alignmentNote:
    "PINE on PCSX2 does NOT enforce alignment — unaligned access typically returns whatever bytes " +
    "are at the aligned address below, silently corrupting the value. If you need an unaligned " +
    "multi-byte read, use pine_read_range and assemble the bytes yourself.",
};

// NOTE on DuckStation:
// stenzek implemented PINE in DuckStation in May 2024 (commit 4311e087)
// then dropped it in September 2024 (commit 19698559, "System: Drop IPC
// server"). DuckStation builds from 2024-09-21 onward have no PINE server.
// We don't ship a DuckStation TargetInfo because there's no PINE to talk
// to. If upstream brings it back, this is the place to add it.

const RPCS3: TargetInfo = {
  name: "rpcs3",
  displayName: "RPCS3",
  system: "PlayStation 3",
  defaultSlot: 28012,
  addressSpaceName: "PPU effective address space",
  usefulRangeHint: "0x00010000-0x0FFFFFFF for PPU main memory (game code & data are loaded dynamically)",
  memoryMap: `
PlayStation 3 PPU effective address space landmarks (RPCS3):
  0x00010000-0x0FFFFFFF  Main memory (256 MiB) — game code, data, heap; layout is DYNAMIC
                          The PS3 dynamically loads code segments; addresses vary per game and per run.
                          Use the disassembler / RAM watcher in RPCS3 to locate specific values
                          before scripting against them.
  0xC0000000+            RSX (GPU) IO-mapped memory — varies; not typically what you want for game state
  0xD0000000+            Stack regions (per-thread)
PS3 is segmented and very dynamic compared to PS1/PS2. Plan on a discovery
phase (RAM watcher in RPCS3 UI) before pine_read* targets stabilize.`.trim(),
  setupHelp:
    "For RPCS3: enable PINE via the IPC menu (see RPCS3 wiki Help:IPC_Protocol). " +
    "Default slot 28012. PINE on RPCS3 is less mature than on PCSX2/DuckStation; some opcodes may not work.",
  savestateInfo:
    "RPCS3 does not use the same savestate-slot model as PCSX2/DuckStation. " +
    "PINE SaveState/LoadState opcodes may be no-ops or return FAIL — use RPCS3's UI for save management.",
  alignmentNote:
    "RPCS3 emulates PowerPC 64-bit; PPU memory is naturally big-endian on hardware but PINE returns " +
    "little-endian-decoded values (matching the protocol). Verify endianness when comparing against " +
    "RPCS3-side dumps.",
};

export const TARGETS: Record<string, TargetInfo> = {
  pcsx2: PCSX2,
  rpcs3: RPCS3,
};

/**
 * Look up a target by name. Unknown targets get a synthetic "generic" record
 * so the server still starts — useful for forward compatibility with PINE
 * emulators we haven't catalogued yet. The synthetic record uses neutral
 * help text and defers memory-map specifics to the user.
 */
export function lookupTarget(name: string): TargetInfo {
  const known = TARGETS[name.toLowerCase()];
  if (known) return known;
  return {
    name: name,
    displayName: name,
    system: "(unknown emulator)",
    defaultSlot: 28011,
    addressSpaceName: "main address space",
    usefulRangeHint: "(consult the emulator's documentation for its memory map)",
    memoryMap:
      `Unknown PINE target "${name}".\n` +
      `The PINE protocol layer works for any emulator that implements it, but mcp-pine has no\n` +
      `built-in memory map for "${name}". Consult the emulator's documentation for valid addresses.`,
    setupHelp:
      `Make sure the emulator at PINE_TARGET=${name} is running with its PINE/IPC server enabled.`,
    savestateInfo:
      "Savestate behavior depends on the emulator. Consult its documentation.",
    alignmentNote:
      "Alignment behavior depends on the emulator. Prefer aligned addresses to avoid silent corruption.",
  };
}
