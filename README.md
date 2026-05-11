# Chrome Gemini Nano On-Device Model

## Overview

Chrome silently downloads a ~4GB Gemini Nano model to this directory for its on-device AI features. This repository contains a CLI tool to interact with the model, an OpenAI-compatible API server, and research findings on the model's format and Chrome's obfuscation mechanism.

## The CLI Tool

A Node.js CLI that sends prompts to Chrome's built-in Gemini Nano model via the Prompt API. It auto-launches Chrome with the required flags, maintains a persistent `LanguageModel` session with conversation history across turns, includes a live dashboard for monitoring context usage and performance, and exposes an OpenAI-compatible API for integration with other tools.

### Features

- **Auto-launch Chrome** — starts Chrome with the required flags if not already running
- **Persistent session** — conversation history carries across turns; use `/reset` to clear
- **Markdown rendering** — model output (bold, code blocks, lists, links) is rendered with ANSI formatting in the terminal
- **Live dashboard** — HTTP status page at `http://localhost:3457` showing context window usage, request count, timing (think/gen split), and token throughput
- **OpenAI-compatible API** — `POST /v1/chat/completions` and `GET /v1/models` endpoints for integration with any OpenAI client
- **Streaming & non-streaming** — both SSE streaming and full response modes
- **Configurable sampling** — set `topK` and `temperature` via CLI flags or the `/config` command at runtime
- **Whitespace stall detection** — detects when the model stalls on indentation-heavy output and aborts gracefully
- **Progress indicator** — animated spinner while the model is thinking/generating
- **Timing stats** — reports prompt processing time, generation time, token count (~chars/4), and tokens/sec after each response
- **Pipe mode** — when stdin is not a TTY, reads from pipe and writes to stdout (e.g. `echo "hello" | node chat.mjs`)
- **Graceful shutdown** — calls `session.destroy()` on exit to release Chrome model memory

### Prerequisites

- macOS, Windows, or Linux with Google Chrome (or Chromium) installed
- Node.js 18+
- Enable these Chrome flags by visiting them in Chrome's address bar:
  - `chrome://flags/#optimization-guide-on-device-model` → **Enabled**
  - `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**
- Restart Chrome after enabling flags and wait for the model to download (~4GB)
- On Windows, use **Windows Terminal** or **PowerShell** — the progress spinner and ANSI formatting don't render correctly in `cmd.exe`

### Installation

```bash
npm install
```

### Usage

**Interactive mode (auto-launches Chrome):**

```bash
node chat.mjs
# Type prompts and press Enter. Conversation history persists across turns.
# Commands: /status, /reset, /config, /exit, /quit, /help
```

**Single prompt:**

```bash
node chat.mjs --prompt "Explain quantum computing in one paragraph"
```

**Pipe mode (non-interactive):**

```bash
echo "What is the capital of France?" | node chat.mjs
cat long_prompt.txt | node chat.mjs --temperature 0.5 --top-k 40
```

**Options:**

| Flag | Description |
|------|-------------|
| `--prompt <text>` | Send a single prompt and exit |
| `--port <n>` | HTTP port for dashboard and API (default: 3457) |
| `--cdp <n>` | Chrome DevTools Protocol port (default: 9222) |
| `--top-k <n>` | Top-K sampling (default: model default) |
| `--temperature <n>` | Temperature (default: model default) |
| `--no-stream` | Wait for full response instead of streaming |
| `--no-launch` | Don't auto-launch Chrome (require it running) |
| `-h`, `--help` | Show help |

**Interactive commands:**

| Command | Description |
|---------|-------------|
| `/status` | Show session stats (turns, context, think/gen timing, tok/s) |
| `/reset` | Reset session and clear conversation history |
| `/config` | View or set model parameters (`topK`, `temperature`) |
| `/exit`, `/quit` | Exit gracefully (destroy session, disconnect) |
| `/help` | Show available commands |
| `exit` / `quit` | Same as `/exit` |

### OpenAI-Compatible API

The server exposes OpenAI-compatible endpoints alongside the dashboard. Any tool that speaks the OpenAI Chat Completions API can use it.

**Base URL:** `http://localhost:3457`

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models (includes context window stats) |
| `GET` | `/v1/models/:id` | Get model details |
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming) |
| `GET` | `/health` | Health check |

**Example — curl (streaming):**

```bash
curl http://localhost:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-nano",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain quantum computing briefly."}
    ],
    "stream": true
  }'
```

**Example — curl (non-streaming):**

```bash
curl http://localhost:3457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-nano",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

**Example — Python (OpenAI SDK):**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3457/v1", api_key="unused")

response = client.chat.completions.create(
    model="gemini-nano",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Testing the API

A test script `test_api.sh` is provided to verify the API with custom parameters.

**Usage:**

```bash
./test_api.sh
```

**Environment Variables:**

- `SYSTEM_MESSAGE` — Instructions for the AI model
- `USER_MESSAGE` — The actual question or task
- `TEMPERATURE` — Controls randomness (default: 0.7)
- `TOP_K` — Top-K sampling parameter (default: 40)
- `STREAM` — Set to `true` for SSE streaming (default: `false`)

**Example:**

```bash
SYSTEM_MESSAGE="You are a helpful assistant." TEMPERATURE=0.9 ./test_api.sh
```

**Integration with Claude Code:**

Claude Code cannot connect to this API directly. To route Claude Code requests to the on-device model, use the [claude-code-router](https://github.com/oakimov/claude-code-router), which provides the required compatibility layer and additional features.

*Note: The Chrome On-Device model logic is currently shared between this project and the router; it will be isolated and unified into a standalone library soon.*

**Request format:**

The API accepts standard OpenAI Chat Completions request bodies. Supported fields:

- `messages` — array of `{role, content}` objects. System prompts are extracted and passed to the model's session. User and assistant messages are concatenated as the prompt.
- `stream` — `true` for SSE streaming, `false` for full JSON response
- `model` — any string (always uses Gemini Nano)
- `temperature` — sampling temperature
- `top_k` — top-K sampling parameter

**Safeguards:**

- **Per-client session isolation**: each API client gets a unique session fingerprinted by IP + User-Agent; the CLI has its own isolated session
- **Auto-compact**: when context usage exceeds 85%, the session is reset with a compaction notice to prevent overflow
- **Whitespace stall detection**: aborts generation after 2000+ consecutive whitespace characters
- **Session persistence**: model sessions persist across requests for conversation continuity within the same client; send a new system prompt to force a session reset
- **Request validation**: messages array validated with OpenAI-style error responses; 1MB body size limit; 120s request timeout

### Web UI (HuggingFace chat-ui)

A preconfigured chat-ui is available via Docker:

```bash
docker compose up
```

Then open http://localhost:3000 in your browser. The UI connects to the local Gemini Nano API automatically.

**Prerequisites:**
- Docker and Docker Compose installed
- `node chat.mjs` running (the API server must be active)

### Dashboard

The tool serves a live dashboard at `http://localhost:3457` (configurable via `--port`). It shows:

- **Status** — session state and turn count
- **Context Window** — current token usage / total window
- **Turns** — number of requests processed
- **Last Prompt/Response** — character counts
- **Think / Gen** — prompt processing time / generation time
- **Tokens** — estimated token count and tokens/sec
- **Log** — browser-side events (session init, thinking time, errors)

### How It Works

The tool auto-launches Chrome (or connects to a running instance), then loads a bridge page over HTTP from the built-in server. The bridge page accesses Chrome's `LanguageModel` API while the same URL serves as a monitoring dashboard for external browsers. The server also translates OpenAI Chat Completions requests into Prompt API calls.

**Architecture:**

```
┌──────────────────────────────┐     ┌──────────────────────────────┐
│  CLI / API Clients           │     │  Chrome (Gemini Nano)        │
│                              │     │                              │
│  chat.mjs ──┬─ Interactive   │     │  page.html (bridge)          │
│             ├─ Pipe mode     │     │   ├─ Multi-session map       │
│             └─ /v1/* API     │     │   │  (sessionId → session)   │
│                  │           │     │   ├─ Streaming + stall det.  │
│                  ▼           │     │   └─ Dashboard UI (CLI)      │
│  lib/server.mjs ── HTTP ◄────────────── CDP ──┘                   │
│  lib/session.mjs ── Puppeteer page.evaluate()                     │
└──────────────────────────────┘     └──────────────────────────────┘
```

1. **Chrome lifecycle** (`chat.mjs`) — auto-launches Chrome with CDP flags or connects to a running instance via `puppeteer-core`.

2. **Session management** (`lib/session.mjs`) — wraps Puppeteer page communication. Manages per-client sessions with independent mutexes. Ensures the bridge page is loaded, creates/destroys `LanguageModel` sessions, handles auto-compact at 85% context usage.

3. **OpenAI-compatible server** (`lib/server.mjs`) — HTTP server with `POST /v1/chat/completions`, `GET /v1/models`, and SSE streaming. Fingerprints clients by IP + User-Agent for session isolation. Extracts system prompts from messages, concatenates user/assistant turns, and translates responses to OpenAI format.

4. **Bridge page** (`page.html`) — loaded in Chrome, accesses `window.LanguageModel`. Maintains a map of independent sessions keyed by session ID. Handles session creation with system prompts, streaming with stall detection, context overflow events, and a live dashboard UI for the CLI session.

---

## Research: Model Obfuscation & Deobfuscation

To use Gemini Nano with external tools like **LM Studio**, **llama.cpp**, or **Ollama**, the model weights would first need to be converted to a standard format like GGUF or Safetensors. However, Chrome's `weights.bin` is obfuscated, making direct conversion impossible without first reversing the obfuscation scheme. This research section outlines our findings on the obfuscation mechanism and current options for deobfuscation.

### Why direct conversion fails

The `weights.bin` file is **not** a standard TFLite FlatBuffer. It is obfuscated at the byte level, making it unreadable by standard ML converters (TFLite, safetensors, GGUF, MLX, etc.).

Key evidence:

- **First bytes**: `36730b0edcb1eb52...` — does not match the TFLite FlatBuffer magic
- **Entropy**: 7.81 bits/byte (first 1KB), 6.61 bits/byte (at ~2GB offset). A standard TFLite model would have much lower entropy due to repeating tensor structures and metadata strings.
- **No tensor names**: Searching for known Gemini Nano tensor name patterns (e.g., `params.lm.transformer`, `self_attention`, `ff_layer`) returns zero results — the metadata is obfuscated too.
- **FlatBuffer parsing fails**: `tflite.Model.Model.GetRootAs(buf) ` throws `TypeError: bad number` because the root table offset is garbage.

### The Obfuscation Library

All deobfuscation is handled by a single closed-source Chrome library:

**`liboptimization_guide_internal.dylib`** (46 MB)

Located at:
```
/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/
  Versions/<chrome-version>/Libraries/liboptimization_guide_internal.dylib
```

This library contains the complete on-device inference stack, including the obfuscation logic (`obfuscation.cc`), LiteRT runtime, and XNNPACK backend.

### Obfuscation Implementation Details

From symbol and string analysis of the library, the obfuscation implementation is located within Chrome's build at:
`components/optimization_guide/internal/third_party/odml/src/odml/infra/genai/inference/utils/llm_utils/obfuscation.cc`

Key error strings reveal the scheme:

| String | What it tells us |
|--------|-----------------|
| `"Input is not valid flatbuffer model. Deobfuscation is not supported yet."` | The loader checks if the input is a valid FlatBuffer; if not, it expects obfuscated input. |
| `"Unsupported obfuscation version:"` | The obfuscation is versioned — different Chrome releases may use different schemes. |
| `"odml.infra.proto.ObfuscationParams"` | Parameters are stored as a protobuf message, likely embedded in the model file. |
| `ModelResourcesTfliteObfuscated` | The model is explicitly tagged as "TFLite Obfuscated." |

### Deobfuscation Options & Comparison

Currently, there are two paths for obtaining deobfuscated weights:

1. **Older Versions (Legacy)**: Older Chrome versions (before the obfuscation was added) shipped `weights.bin` as a plain TFLite FlatBuffer. These can be parsed directly using tools like [ethanc8/Gemini-Nano](https://github.com/ethanc8/Gemini-Nano). Pre-converted weights are available on HuggingFace at `QuietImpostor/Gemini-Nano-Safetensors`.
2. **Reverse Engineering (Current)**: The current obfuscation scheme (introduced to prevent extraction) requires reversing the logic in `liboptimization_guide_internal.dylib`. As the error string states: *"Deobfuscation is not supported yet"* — implying it is not intended to be supported outside of Chrome's internal library.

Research suggests that deobfuscation happens entirely in-memory: raw bytes are decoded before being passed to the TFLite interpreter, meaning the deobfuscated model never touches the disk.

### Model Architecture

From the community converter and prior analysis of older (non-obfuscated) versions:

- **Base architecture**: Gemma 1 (not Gemma 2) with proprietary modifications
- **Quantization**: Mixed INT4 (excess-8 encoding) and INT8 with per-dimension float32 scales
- **Attention**: Grouped Query Attention (GQA) with 8 attention heads, 1 KV head
- **Hidden size**: 2048
- **Intermediate size**: 16384 (for MLP layers)
- **Layers**: 18 transformer layers
- **Vocab**: ~256K tokens (tied embedding/lm_head)

The converter maps Gemini Nano's internal tensor names to HuggingFace Gemma naming conventions (e.g., `self_attention.q` → `self_attn.q_proj`, `ff_layer.ffn_layer1_gate` → `mlp.gate_proj`).

---

## File Structure

```
.
├── chat.mjs                       # CLI entry point (Chrome lifecycle, interactive mode)
├── docker-compose.yml             # HuggingFace chat-ui preconfigured for local API
├── test_api.sh                    # API test script with custom parameters
├── page.html                      # Browser bridge (session, streaming, dashboard UI)
├── lib/
│   ├── session.mjs                # SessionManager — Puppeteer page communication, auto-compact
│   └── server.mjs                 # HTTP server — OpenAI-compatible API + dashboard hosting
├── find_weights.js                # Utility to locate obfuscated model file
├── package.json
├── README.md
├── THIRD_PARTY_LICENSES.txt       # Licenses for external dependencies
└── node_modules/
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `puppeteer-core` | Connect to Chrome via CDP (no bundled browser) |
| `marked` | Parse Markdown from model output |
| `marked-terminal` | Render Markdown with ANSI formatting in terminal |

---

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.

### Third-Party Licenses

This project incorporates several third-party libraries. For a full list of these libraries and their respective licenses, please refer to [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
