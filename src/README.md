# src/

TypeScript source for the `mcp-pine` MCP server (Node.js). Compiled into
`../dist/` by `tsc` — that's what the published `mcp-pine` bin runs.

## Files

- **`index.ts`** — stdio MCP entrypoint. Reads `PINE_TARGET`, `PINE_SLOT`,
  `PINE_HOST`, `PINE_SOCKET_PATH`. Renders per-target tool descriptions at
  startup based on `PINE_TARGET`.
- **`pine.ts`** — PINE client. Binary wire protocol, TCP on Windows, Unix
  domain socket (`<target>.sock.<slot>`) on Linux/macOS. Serializes reads
  to avoid PCSX2's pipeline-wedge bug (see CLAUDE.md).
- **`targets.ts`** — per-target metadata: default slot, memory map, setup
  blurb. Adding a new PINE emulator means adding an entry here, not
  branching in `tools.ts`.
- **`tools.ts`** — MCP tool definitions. Tools are `pine_*` (not emulator-
  specific) because PINE is the protocol, not any one emulator.

## Build

```bash
npm run dev      # tsc --watch
npm run build    # one-shot
```

Output goes to `../dist/index.js`.
