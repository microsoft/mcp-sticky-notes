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

## Configuration (environment variables)

- TRANSPORT_TYPE: `http` (default) or `stdio`
- AZURE_STORAGE_ACCOUNT: Azure Storage account name (required for Azure Table Storage)
- AZURE_STORAGE_KEY: Account key (optional — used as fallback)
- NOTES_TABLE_NAME: (optional) custom table name (default: `StickyNotesData` in code)
- PORT: HTTP port (default: `3000`)
- HOST: bind host (default: `0.0.0.0`)
- MCP_USER_ID: persistent user id to pin notes to a stable user space
- LOG_LEVEL: default server log level (`info`)

Behavior:
- The server will attempt to authenticate to Azure using Managed Identity (DefaultAzureCredential). If that fails and `AZURE_STORAGE_KEY` exists, it will try storage key auth. If both fail, the server uses an in-memory store.

## Running the server

Start in development mode (hot reload using ts-node watch):

npm run dev

Start normally:

npm start

To run in STDIO transport mode (suitable for embedding inside an MCP-aware host), set:

$env:TRANSPORT_TYPE = 'stdio'; npm start   # PowerShell example

## HTTP endpoints (MCP transport)

The server uses the MCP JSON-RPC endpoints on `/mcp`.

- POST /mcp — JSON-RPC requests (initialize and method calls)
- GET /mcp — open SSE stream for a session (requires `mcp-session-id` header)
- DELETE /mcp — terminate a session (requires `mcp-session-id` header)

Note: For standard MCP usage the client should first send an MCP initialization request. The server will create a session transport for the client and return a generated `mcp-session-id` header which must be used for subsequent requests and SSE connections.

### Quick examples

Set log level (direct handler; does not require session initialization):

curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -d \
'{"jsonrpc":"2.0","id":1,"method":"logging/setLevel","params":{"level":"debug"}}'

Add a note (MCP method `addNote` — requires an initialized MCP session):

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "addNote",
  "params": { "text": "Buy milk \nand eggs", "key": "personal" }
}

Get a note (most-recent for a key):

{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "getNote",
  "params": { "key": "personal" }
}

List all notes (returns textual summary and a board PNG when possible):

{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "listNotes",
  "params": {}
}

Remove a note (logical key):

{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "removeNote",
  "params": { "key": "personal" }
}

Clear all notes:

{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "clearNotes",
  "params": {}
}

Important: For calls other than `logging/setLevel` and `logging/getLevel`, the HTTP transport expects a prior initialize request so it can create and store a session-backed transport. Use a compliant MCP client (or an `initialize` JSON-RPC request) and capture the `mcp-session-id` header returned by the server. Use that header value on subsequent POST/GET/DELETE requests in the `mcp-session-id` header.

## Storage and persistence

- Azure Table Storage entities are stored with the PartitionKey set to `user-<id>` and a unique RowKey per note. Each entity contains a `noteKey` (logical key), `text` and `timestamp`.
- If Azure is not available the server keeps data in memory (per-process) under the same keying scheme.
- Use `MCP_USER_ID` environment variable to pin notes to a single persistent user across restarts.

## Images

The server attempts to render each note as a PNG using `node-canvas`. If rendering fails (common on platforms that lack native dependencies), the server falls back to text-only responses. The list board view will try to render a combined image of all notes when possible.

If you rely on image output in production, ensure the runtime environment has the native libraries required for `canvas` and `sharp`.

## Troubleshooting

- If images do not render and `canvas` reports errors, install the native dependencies (Cairo, Pango, libjpeg, etc.) for your OS.
- If Azure authentication fails, ensure Managed Identity is available or set `AZURE_STORAGE_KEY` for fallback.
- The server prints helpful debug logs to stdout/stderr — use `LOG_LEVEL=debug` to increase verbosity.

## Contributing

Contributions are welcome. Please open issues or PRs to improve functionality, add tests, or improve cross-platform image generation.

## License

MIT
