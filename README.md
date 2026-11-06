# Lumen Studio

A server-hosted web client for OpenAI-compatible chat APIs, with persistent conversations, model discovery, reasoning display, and LM Studio model management.

The interface follows your browser's preferred language: Chinese for Chinese language settings, and English otherwise.

## Quick start

Requires Node.js 20.3 or later. No application dependencies need to be installed.

1. Download and extract this repository, or clone it.
2. On Windows, double-click **`start.bat`**. A CMD window opens and launches the website in your browser.
3. Open **API connection**, enter your API base URL and optional API key, then click **Connect**.
4. Select a discovered model and start chatting.

Keep the CMD window open while using the website. Closing it stops the server. The default address is `http://127.0.0.1:4177`.

On other platforms, run:

```sh
node scripts/dev.mjs
```

Then open the address shown in the terminal.

## API compatibility

Compatibility depends on the API protocol and the features exposed by the server. This client does not support every API format or authenticate with every provider.

| Capability | Support |
| --- | --- |
| Model discovery | `GET /v1/models`; the current connection flow requires a model list |
| Chat | `POST /v1/chat/completions`, streaming SSE and non-streaming JSON |
| Authentication | Optional `Authorization: Bearer <key>` |
| Base URLs | HTTP/HTTPS, root URLs, `/v1` URLs, and reverse-proxy path prefixes |
| Sampling | Temperature, Top P, presence/frequency penalties, seed, stop sequences, and manual output limits |
| Extended parameters | Top K, repeat penalty, JSON object output, reasoning effort, and extra request JSON, when supported by the server |
| Images | Base64 image content in `image_url` messages; requires a vision-capable model and API |
| Text attachments | Text embedded in the chat request; no separate file-upload API |
| Reasoning | Common reasoning fields, structured reasoning text, and `<think>` / `<thinking>` tags |
| Tool calls | Function/tool definitions and manually submitted tool results; no automatic tool execution |
| Embeddings | A test interface for `POST /v1/embeddings` |
| Usage | Input/output tokens and cache-hit statistics when returned by the API; output estimates are marked with `≈` |
| LM Studio management | Model information, load/unload, download, and download status through `/api/v1/models` and its management endpoints |
| LM Studio load settings | Context length, batch size, Flash Attention, KV-cache offloading, and expert count, when exposed by the server |

Sampling overrides and output-token limits are **off by default**. No `max_tokens` or `max_completion_tokens` limit is added unless you explicitly configure one. History trimming is also off by default.

Some APIs reject `stream_options.include_usage`; disable **Include usage** for those servers. API-specific parameters may require **Extra parameters**, and unsupported fields can still be rejected by the server.

### Current limits

- No native OpenAI Responses API, Anthropic Messages API, Gemini API, or Azure-specific API-key/query-parameter adapter. A compatible Chat Completions gateway may work if it exposes the required endpoints.
- No OAuth login, custom authentication headers, automatic agents/MCP execution, audio/video APIs, image generation, or PDF parsing.
- Context-window and current load information are read from LM Studio's native API. Standard chat APIs often do not expose their active server settings.
- Cache statistics display what the API reports; this client does not enable or control server-side caching.
- Protocol behavior is covered by local mock-server tests. Individual providers and models have not all been tested with live credentials.

## Features

- Multiple API connections, model search, chat history, import/export, attachments, and light/dark themes.
- Streaming responses, stop/retry, edit/regenerate, reasoning display, and received-token counters.
- Parameter presets, system prompts, request previews, and per-model shared settings.
- LM Studio model management when its native management API is available.

## Server storage and Nginx deployment

Each conversation is saved as its own JSON file. Ungrouped chats live in data/conversations/; projects have independent data/projects/<project-id>/project.json metadata and conversations/ directories. The workspace.json file stores the global index, connection profiles, saved API keys, and presets. Each project records its relative directory path, which stays stable after a rename. Model settings remain in data/model-configs.json. The sidebar initially fetches at most 15 conversation titles across all expanded project folders and Ungrouped combined; project names do not count toward this limit. Opening a folder prioritizes its entries in the shared budget. Load more adds 15 entries and runs only on click. Expanded folders, the loaded limit, search, sidebar scroll, and the active chat are saved on the server and restored on reload. Message bodies are fetched only when opening a chat, and only changed chats/settings are submitted on save. Desktop users can drag a chat entry or the right-hand chat title into a folder or back to Ungrouped; the move button also remains available.

The browser keeps the current UI state in memory and does not write new chats or keys to localStorage/sessionStorage. Saved keys are stored per connection ID and are never returned by workspace APIs. Connections sharing an API address can have different keys. A blank key field preserves the saved key; unchecking **Save key on server** keeps a typed key only in the current page's memory. Saved keys are injected by the server relay.

Different browsers visiting the same server use the same workspace. This version has no login or per-user separation. Saved keys are plain text in the server data file. Requests send content and credentials to the configured API; proxy mode also passes them through this server. Exported conversation backups do not include API keys.

For a Git-managed server, run `node scripts/dev.mjs` from the clone and proxy the site to Node. Future updates use `git pull --ff-only origin main` followed by a service restart; no build or archive is required. Existing custom-server SQLite data can migrate automatically while keeping its original service environment and database. See [the upgrade guide](deploy/UPGRADE.md). A standalone `dist/` build remains optional; see [the deployment guide](deploy/README.md) and [Nginx configuration](deploy/nginx.conf).

Set LUMEN_DATA_DIR to select a persistent server data directory; its default is the project's data/ directory. Keep and back up this directory across updates and restarts. Run one Node instance against it. Changed conversation/project files are written atomically with revision checks and a recovery journal. Concurrent chat/connection edits save conflict copies, and edits after remote deletion save recovery copies. Idle pages poll revisions every three seconds without loading all messages, preserving drafts and the local view. Model requests wait for the question to be saved; final output is flushed and unsaved changes trigger the browser's leave-page prompt. Total workspace save size is limited to 128 MiB; streaming output is saved periodically, and saving failures remain visible with retry support.

Use **Settings → Data → Import legacy browser data** to copy this browser's old records or presets to the server. After a successful save, migrated Lumen browser entries are removed; failed imports retain them. Opening the new version never automatically replaces server records with old local records. Chat JSON import/export also preserves project membership. Earlier single-file JSON data migrates automatically, keeping workspace.json.v1.bak intact. Existing SQLite deployments keep their original database and write to an adjacent JSON index after migration; this migration requires Node 22.13+. Create a project with the current chat, every chat in the selected group, or an empty conversation; moving chats changes their disk location. Deleting a project moves its conversations to Ungrouped.

The browser-only version is preserved on the [always-local-save branch](https://github.com/ruitong23/WebChat-withAnyApi/tree/always-local-save).

## Development

```sh
npm start
npm test
```

`src/` contains the frontend, relay, and shared-settings store. `scripts/dev.mjs` runs the local Node server. Optional browser checks require Playwright and Chrome. Run npm run test:server for cross-browser storage, service restart, and reverse-proxy checks; npm run test:scroll checks desktop and mobile scrolling. Run npm run test:projects for project creation, moving files, bulk grouping, backup round-trips, and mobile navigation. Run npm run test:paging for the shared 15-entry budget, lazy body loading, restored view state, incremental saves, and real drag-and-drop with 60 conversations.

`npm run build` creates a self-contained Node deployment in `dist/`, including `public/`, `server/`, and Nginx/systemd examples. `npm run validate` checks its paths and JavaScript syntax. No npm dependencies are needed at runtime.

`npm run test:upgrade` exercises SQLite/WAL migration, same-address credentials, secret-free responses, live synchronization, conflict copies, presets-only import, and the existing service environment against local mock APIs. SQLite migration tests require Node 22.13+.

This is an independent client and is not an official LM Studio product.
