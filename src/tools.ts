import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PineClient } from "./pine.js";

const PS2_REGIONS = `
PlayStation 2 main address space landmarks:
  0x00000000  EE main RAM (32 MiB) — game code & data
  0x10000000  Hardware registers (DMA, GIF, VIF, etc.)
  0x11000000  VU0 / VU1 memory
  0x12000000  GS privileged registers
  0x1C000000  IOP RAM (2 MiB)
  0x1F800000  IOP scratchpad
  0x70000000  EE scratchpad (16 KiB)
PINE memory operations target the EE address space.`.trim();

const TOOLS: Tool[] = [
  {
    name: "pine_ping",
    description: "Verify the PINE connection by querying the emulator version. Returns the version string if reachable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pine_get_info",
    description: "Get the loaded game's title, serial (e.g. SLUS-21274), disc CRC, game version, and emulator status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pine_get_status",
    description: "Get the current emulator state: 'running', 'paused', 'shutdown', or 'unknown'.",
    inputSchema: { type: "object", properties: {} },
  },

  {
    name: "pine_read8",
    description: `Read a single unsigned byte (u8) from emulated memory.\n\n${PS2_REGIONS}`,
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "integer", description: "Memory address" } },
    },
  },
  {
    name: "pine_read16",
    description: "Read an unsigned 16-bit little-endian value from emulated memory. Address should be 2-byte aligned.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "integer", description: "Memory address (2-byte aligned)" } },
    },
  },
  {
    name: "pine_read32",
    description: "Read an unsigned 32-bit little-endian value from emulated memory. Address should be 4-byte aligned.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "integer", description: "Memory address (4-byte aligned)" } },
    },
  },
  {
    name: "pine_read64",
    description: "Read an unsigned 64-bit little-endian value from emulated memory. Address should be 8-byte aligned. Returned as a string to preserve precision past 2^53.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "integer", description: "Memory address (8-byte aligned)" } },
    },
  },

  {
    name: "pine_write8",
    description: "Write a byte (u8) to emulated RAM. Writes to ROM/read-only regions are silently ignored by the emulator.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", description: "Memory address" },
        value:   { type: "integer", minimum: 0, maximum: 255 },
      },
    },
  },
  {
    name: "pine_write16",
    description: "Write a 16-bit value (LE) to emulated RAM. Address must be 2-byte aligned.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", description: "Memory address (2-byte aligned)" },
        value:   { type: "integer", minimum: 0, maximum: 65535 },
      },
    },
  },
  {
    name: "pine_write32",
    description: "Write a 32-bit value (LE) to emulated RAM. Address must be 4-byte aligned.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", description: "Memory address (4-byte aligned)" },
        value:   { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "pine_write64",
    description: "Write a 64-bit value (LE) to emulated RAM. Address must be 8-byte aligned. Pass the value as a decimal string to preserve precision past 2^53.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", description: "Memory address (8-byte aligned)" },
        value:   { type: "string", pattern: "^[0-9]+$", description: "Decimal string (e.g. \"18446744073709551615\")" },
      },
    },
  },

  {
    name: "pine_save_state",
    description: "Trigger the emulator to save its current state to a numbered slot.",
    inputSchema: {
      type: "object",
      required: ["slot"],
      properties: {
        slot: { type: "integer", minimum: 0, maximum: 255, description: "Save state slot (0-255)" },
      },
    },
  },
  {
    name: "pine_load_state",
    description: "Trigger the emulator to load a previously-saved state from a numbered slot.",
    inputSchema: {
      type: "object",
      required: ["slot"],
      properties: {
        slot: { type: "integer", minimum: 0, maximum: 255, description: "Save state slot (0-255)" },
      },
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
