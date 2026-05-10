# Chrome Gemini Nano On-Device Model

## Overview

Chrome silently downloads a ~4GB Gemini Nano model to this directory for its on-device AI features. This repository contains a CLI tool to interact with the model, along with research findings on the model's format and Chrome's obfuscation mechanism.

## Model Files

| File | Size | Description |
|------|------|-------------|
| `weights.bin` | ~3.98 GB | The model weights (obfuscated) |
| `manifest.json` | ~200 B | Component manifest (version, model spec) |
| `on_device_model_execution_config.pb` | — | Execution configuration (protobuf) |
| `_metadata/verified_contents.json` | — | Chrome component update metadata with SHA-256 treehashes |

The manifest identifies this as:

```json
{
  "name": "Optimization Guide On Device Model",
  "version": "2025.8.8.1141",
  "BaseModelSpec": {
    "name": "v3Nano",
    "version": "2025.06.30.1229"
  }
}
```

## The CLI Tool

A Node.js CLI that sends prompts to Chrome's built-in Gemini Nano model via the Prompt API. It auto-launches Chrome with the required flags, maintains a persistent `LanguageModel` session with conversation history across turns, and includes a live dashboard for monitoring context usage and performance.

### Features

- **Auto-launch Chrome** — starts Chrome with the required flags if not already running
- **Persistent session** — conversation history carries across turns; use `/reset` to clear
- **Markdown rendering** — model output (bold, code blocks, lists, links) is rendered with ANSI formatting in the terminal
- **Live dashboard** — HTTP status page at `http://localhost:3457` showing context window usage, request count, timing (think/gen split), and token throughput
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
| `--port <n>` | HTTP port for dashboard (default: 3457) |
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

The tool auto-launches Chrome (or connects to a running instance), then loads a bridge page over HTTP from the built-in dashboard server. The bridge page accesses Chrome's `LanguageModel` API while the same URL serves as a monitoring dashboard for external browsers.

1. **Persistent session** — `LanguageModel.create()` creates a session that lives across all turns, so conversation history accumulates naturally. The `contextoverflow` event warns when old messages are evicted. `topK` and `temperature` can be configured at creation time via CLI flags or the `/config` command.

2. **Evaluate-based inference** — `session.promptStreaming()` runs entirely inside the browser via `page.evaluate()`, avoiding fragile polling. The full `for-await` loop completes in-browser and returns `{response, truncated, elapsed, thinkMs, genMs}`.

3. **Markdown rendering** — model output is parsed with `marked` + `marked-terminal` and rendered with ANSI escape codes for bold, italic, code blocks (with syntax highlighting), lists, links, and tables.

4. **Whitespace stall detection** — if the model produces 2000+ consecutive whitespace characters with no content, the stream is aborted to prevent hanging.

5. **Dashboard** — the same HTTP server that serves the bridge page to Chrome also serves a monitoring dashboard for any browser on the network, showing context usage, think/gen timing split, and token throughput.

This approach avoids needing to deobfuscate or convert the model at all — Chrome handles everything internally.

---

## Research: Model Obfuscation

### Why Can't We Convert `weights.bin` to GGUF to use it in llama.cpp or LM Studio?

The `weights.bin` file is **not** a standard TFLite FlatBuffer. It is obfuscated, making it unreadable by any standard ML tool or converter (TFLite, safetensors, GGUF, MLX, etc.).

Key evidence:

- **First bytes**: `36730b0edcb1eb52...` — does not match the TFLite FlatBuffer magic
- **Entropy**: 7.81 bits/byte (first 1KB), 6.61 bits/byte (at ~2GB offset). A standard TFLite model would have much lower entropy due to repeating tensor structures and metadata strings.
- **No tensor names**: Searching for known Gemini Nano tensor name patterns (e.g., `params.lm.transformer`, `self_attention`, `ff_layer`) returns zero results — the metadata is obfuscated too.
- **FlatBuffer parsing fails**: `tflite.Model.Model.GetRootAs(buf)` throws `TypeError: bad number` because the root table offset is garbage.

### The Obfuscation Library

All deobfuscation is handled by a single closed-source Chrome library:

**`liboptimization_guide_internal.dylib`** (46 MB)

Located at:
```
/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/
  Versions/<chrome-version>/Libraries/liboptimization_guide_internal.dylib
```

This library contains the complete on-device inference stack:
- **Obfuscation logic** (`obfuscation.cc`)
- **LiteRT** (formerly TFLite) runtime
- **XNNPACK** CPU inference backend
- **Model loading and weight deobfuscation**

### Obfuscation Implementation Details

From symbol and string analysis of the dylib:

**Source path within Chrome's build:**
```
components/optimization_guide/internal/third_party/odml/src/odml/infra/genai/inference/utils/llm_utils/obfuscation.cc
```

**Key error strings reveal the obfuscation scheme:**

| String | What it tells us |
|--------|-----------------|
| `"Input is not valid flatbuffer model. Deobfuscation is not supported yet."` | There is a check: if the input is already a valid FlatBuffer, skip deobfuscation. If not, it expects obfuscated input. |
| `"Unsupported obfuscation version:"` | The obfuscation is versioned — different Chrome releases may use different schemes. |
| `"odml.infra.proto.ObfuscationParams"` | Obfuscation parameters are stored as a protobuf message, likely embedded in the model file or a sidecar config. |
| `ModelResourcesTfliteObfuscated` | This is the resource type name — confirming the model is explicitly tagged as "TFLite Obfuscated." |

**Main C API entry point:**

```
_GetChromeMLAPI
```

This is the single exported symbol that Chrome's higher-level code calls to get the ML API function table. From there, model loading flows through the deobfuscation path.

### Obfuscation Scheme (Reconstructed)

Based on the evidence:

1. **Detection**: The loader checks if `weights.bin` is a valid TFLite FlatBuffer. If not, it treats it as obfuscated.
2. **Parameters**: Obfuscation parameters (likely a key/algorithm identifier) are stored in `ObfuscationParams` protobuf, possibly within `on_device_model_execution_config.pb` or embedded in the file itself.
3. **Versioning**: The obfuscation has a version field, suggesting the scheme may change across Chrome releases.
4. **In-memory deobfuscation**: The raw bytes are decoded in memory before being passed to the TFLite interpreter — the deobfuscated model never touches disk.
5. **High entropy**: The near-maximum entropy (7.81/8.0 bits/byte) suggests encryption or strong byte-level transformation, not just XOR or simple encoding.

### Comparison With Older Versions

Older Chrome versions (before the obfuscation was added) shipped `weights.bin` as a plain TFLite FlatBuffer. The community converter at [ethanc8/Gemini-Nano](https://github.com/ethanc8/Gemini-Nano) could parse these directly and extract weights to safetensors format. Pre-converted weights from those older versions are available on HuggingFace at `QuietImpostor/Gemini-Nano-Safetensors`.

The obfuscation was introduced specifically to prevent this kind of extraction. As the error string states: *"Deobfuscation is not supported yet"* — suggesting it may never be supported outside of Chrome's own internal library.

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
├── package.json                       # Node.js project
├── chat.mjs                           # CLI entry point (auto-launch, dashboard server)
├── page.html                          # Browser bridge (session, stall detection, dashboard UI)
├── README.md
├── find_weights.js                    # Utility to locate obfuscated model file
└── node_modules/                      # Dependencies
```
