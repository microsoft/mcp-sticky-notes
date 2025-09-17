# MCP Sticky Notes Server (Azure)

A small MCP (Model Context Protocol) server that manages colorful sticky notes with optional visual PNG renderings. It stores notes in Azure Table Storage (preferred via Managed Identity or an account key fallback) and falls back to in-memory storage when Azure is unavailable. The server exposes MCP tools for adding, removing, listing and clearing notes and supports both HTTP and STDIO transports.

## Examples
<img width="2299" height="916" alt="addNote" src="https://github.com/user-attachments/assets/b0b34ebb-3911-4753-95d2-679fc3faa9a2" />

<img width="2278" height="1282" alt="listNotes" src="https://github.com/user-attachments/assets/8c308cde-db93-4e61-a362-22add2b0fe9e" />

<img width="2494" height="1429" alt="mcp-inspector1" src="https://github.com/user-attachments/assets/779c2483-6a20-4520-ba11-8f0685a4f28b" />

<img width="2495" height="1428" alt="mcp-inspector2" src="https://github.com/user-attachments/assets/93c11a4c-7a95-4000-b321-ebb5b7c0c0d4" />

<img width="1218" height="521" alt="chatListNote" src="https://github.com/user-attachments/assets/4e8865e8-f6f5-4d69-9c33-9b5ac565a7e9" />

<img width="1229" height="564" alt="chatAddNote" src="https://github.com/user-attachments/assets/1c2d534a-3000-4437-bcf0-c2b8a4955412" />

<img width="1228" height="1457" alt="chatListNotes" src="https://github.com/user-attachments/assets/7537e362-35b7-4403-83a4-4bef6aa76e2c" />


## Features

- Add, remove, read and list sticky notes
- Group notes by logical key (e.g. `personal`, `work`, `ideas`)
- Visual PNG generation for single notes and a board view using node-canvas
- Azure Table Storage support (Managed Identity primary, Storage Key fallback)
- In-memory fallback storage when Azure is not available
- HTTP transport for web clients (SSE support) and STDIO transport for direct MCP clients
- Simple logging control via MCP tools (`logging-set-level`, `logging-get-level`)

## Requirements

- Node.js >= 22
- npm
- Native build dependencies for `canvas` and `sharp` on Linux (if running in Linux/Azure): install Cairo, Pango, libjpeg, giflib, librsvg, etc.

On Debian/Ubuntu, for example:

sudo apt-get update; sudo apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

(Windows users should install canvas prebuilt or follow platform-specific instructions.)

## Installation

1. Clone the repository.
2. Install dependencies:

npm install

3. Build (optional):

npm run build

## Run on localhost

Run the MCP server manually.
`npx ts-node server.ts`
Server will respond on localhost:3000

in mcp.json, set
{
  "servers": {
    "mcp-sticky-notes": {
      "url": "http://localhost:3000/mcp?userId=demo_user"
    }
  }
}

## Debug with MCP inspector

Run MCP inspector
`npx @modelcontextprotocol/inspector`
Set command = "http://localhost:3000/mcp?userId=demo_user"

## HTTP endpoints (MCP transport)

The server uses the MCP JSON-RPC endpoints on `/mcp`.

- POST /mcp — JSON-RPC requests (initialize and method calls)
- GET /mcp — open SSE stream for a session (requires `mcp-session-id` header)
- DELETE /mcp — terminate a session (requires `mcp-session-id` header)

Note: For standard MCP usage the client should first send an MCP initialization request. The server will create a session transport for the client and return a generated `mcp-session-id` header which must be used for subsequent requests and SSE connections.

## Storage and persistence

- Azure Table Storage entities are stored with the PartitionKey set to `user-<id>` and a unique RowKey per note. Each entity contains a `noteKey` (logical key), `text` and `timestamp`.
- If Azure is not available the server keeps data in memory (per-process) under the same keying scheme.
- Use `MCP_USER_ID` environment variable to pin notes to a single persistent user across restarts.

## Images

The server attempts to render each note as a PNG using `node-canvas`. If rendering fails (common on platforms that lack native dependencies), the server falls back to text-only responses. The list board view will try to render a combined image of all notes when possible.

If you rely on image output in production, ensure the runtime environment has the native libraries required for `canvas` and `sharp`.

## License

MIT
