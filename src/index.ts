#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";
import { PineClient } from "./pine.js";
import { registerTools } from "./tools.js";
import { lookupTarget, TARGETS } from "./targets.js";

const TARGET_NAME = (process.env.PINE_TARGET ?? "pcsx2").toLowerCase();
const target = lookupTarget(TARGET_NAME);
// If PINE_SLOT is unset, fall back to the target's default slot rather than
// always defaulting to 28011 — DuckStation and RPCS3 may use different slots.
const SLOT = parseInt(process.env.PINE_SLOT ?? String(target.defaultSlot), 10);
const HOST = process.env.PINE_HOST;          // optional TCP override
const SOCK = process.env.PINE_SOCKET_PATH;   // optional Unix socket path override

async function main() {
  const pine = new PineClient({
    target:     target.name,
    slot:       SLOT,
    host:       HOST,
    socketPath: SOCK,
  });

  // Surface the resolved target so the user can confirm we're pointing at
  // the right emulator. If PINE_TARGET was unknown, lookupTarget returned
  // a synthetic record — flag that loudly so the user knows tool help text
  // will be generic.
  const known = !!TARGETS[TARGET_NAME];
  process.stderr.write(
    `[mcp-pine] target=${target.name} (${target.displayName} — ${target.system})` +
    (known ? "" : "  [WARNING: unknown target — using generic memory map context]") +
    "\n",
  );

  // Try to connect eagerly so we can give a clear startup message either way.
  try {
    await pine.connect();
    process.stderr.write(`[mcp-pine] connected to ${pine.describeTarget()}\n`);
  } catch (err) {
    process.stderr.write(
      `[mcp-pine] WARNING: could not connect to PINE server (${pine.describeTarget()}): ${err}\n` +
      `           Make sure the emulator is running with PINE enabled.\n` +
      `           ${target.setupHelp}\n`,
    );
  }

  const server = new Server(
    { name: "mcp-pine", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(server, pine, target);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-pine] MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[mcp-pine] fatal: ${err}\n`);
  process.exit(1);
});
