#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PineClient } from "./pine.js";
import { registerTools } from "./tools.js";

const TARGET = process.env.PINE_TARGET ?? "pcsx2";
const SLOT   = parseInt(process.env.PINE_SLOT ?? "28011", 10);
const HOST   = process.env.PINE_HOST;          // optional TCP override
const SOCK   = process.env.PINE_SOCKET_PATH;   // optional Unix socket path override

async function main() {
  const pine = new PineClient({
    target:     TARGET,
    slot:       SLOT,
    host:       HOST,
    socketPath: SOCK,
  });

  // Try to connect eagerly so we can give a clear startup message either way.
  try {
    await pine.connect();
    process.stderr.write(`[mcp-pine] connected to ${pine.describeTarget()} (target=${TARGET})\n`);
  } catch (err) {
    process.stderr.write(
      `[mcp-pine] WARNING: could not connect to PINE server (${pine.describeTarget()}): ${err}\n` +
      `           Make sure the emulator is running with PINE enabled.\n` +
      `           For PCSX2: Settings > Advanced > Enable PINE Server (default port 28011).\n`,
    );
  }

  const server = new Server(
    { name: "mcp-pine", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(server, pine);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-pine] MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[mcp-pine] fatal: ${err}\n`);
  process.exit(1);
});
