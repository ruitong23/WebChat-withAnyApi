# Lumen Studio

A local web client for OpenAI-compatible chat APIs, with model discovery, configurable parameters, reasoning display, and LM Studio model management.

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

## Data and privacy

- Chats, chat attachments, and connection profiles are stored in each browser's local storage.
- API keys use session storage by default. **Remember key** uses local storage. Browser storage is not encrypted.
- Requests send chat content, attachments, and the API key to the API URL you configure. Proxy mode also passes them through the machine running this application. The upstream service controls its own retention policy.
- The application server does not persist chat bodies, chat attachments, or API keys. Shared model settings, including system prompts, API source URLs, model IDs, and parameters, are saved in `data/model-configs.json`.
- Users of the same server and API/model combination can read and edit shared settings. There is currently no login or per-user access control.
- The server listens on `0.0.0.0:4177` by default for LAN access. Set `LUMEN_HOST=127.0.0.1` for access from the same computer only. Set `PORT` to change the port.
- `.gitignore` excludes runtime data, exports, environment files, private-key files, test output, and local deployment configuration. Browser data is not part of the repository.

Use the Node server for the complete application. Static hosting alone does not provide the API proxy or shared-settings service.

## Development

```sh
npm start
npm test
```

`src/` contains the frontend, relay, and shared-settings store. `scripts/dev.mjs` runs the local Node server. Optional browser checks require Playwright and Chrome.

`npm run build` creates a Worker artifact in `dist/server/index.js`; `npm run validate` checks that artifact. The Worker artifact currently provides the frontend and relay, while the shared-settings API is implemented by the Node server.

This is an independent client and is not an official LM Studio product.
