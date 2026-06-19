# Dockerfile — primarily for the Glama MCP registry (https://glama.ai/mcp/servers).
#
# Builds the MCP server and runs it over stdio. The server starts cleanly
# WITHOUT a PINE-speaking emulator present: it logs a note that the bridge is
# unreachable and still serves tools/list. That's exactly what Glama's
# "start + respond to introspection" check needs.
#
# For actual use you don't need Docker — `npm install -g mcp-pine` and point
# it at a running PCSX2 (or other PINE emulator). See README.md.

FROM node:22-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82
WORKDIR /app

# Install dependencies. --ignore-scripts skips the `prepare` hook; we run the
# build explicitly below so the layer caching is predictable.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# The MCP server speaks JSON-RPC over stdio.
ENTRYPOINT ["node", "dist/index.js"]
