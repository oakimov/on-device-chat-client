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

A Node.js CLI that sends prompts to Chrome's built-in Gemini Nano model via the Prompt API. It connects to a running Chrome instance using Puppeteer, creates a `LanguageModel` session, and streams responses to the terminal.

### Prerequisites

- macOS with Google Chrome installed at `/Applications/Google Chrome.app`
- Node.js 18+
- Enable these Chrome flags by visiting them in Chrome's address bar:
  - `chrome://flags/#optimization-guide-on-device-model` → **Enabled**
  - `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**
- Restart Chrome after enabling flags and wait for the model to download (~4GB)
- You must launch Chrome from the terminal with remote debugging enabled (see instructions below).

### Installation

```bash
npm install
```

### Starting Chrome

Before using the CLI, you must completely close all instances of Chrome and start it from your terminal with the remote debugging port and a dedicated user data directory enabled:

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile
```

**Windows:**
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug-profile
```

### Usage

**Single prompt:**

```bash
node chat.mjs --prompt "Explain quantum computing in one paragraph"
```

**Interactive mode:**

```bash
node chat.mjs
# Type prompts and press Enter. Type "exit" to quit.
```



**Options:**

| Flag | Description |
|------|-------------|
| `--prompt <text>` | Send a single prompt and exit |
| `--model-path <p>` | Path to weights.bin (bypasses profile requirements) |
| `--no-stream` | Wait for full response instead of streaming |
| `-h`, `--help` | Show help |

### How It Works

The tool uses Puppeteer to connect to your running Chrome instance on port 9222, then loads a minimal HTML page that calls Chrome's `LanguageModel` JavaScript API:

```js
const session = await LanguageModel.create();
const stream = session.promptStreaming("Hello!");
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

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
├── chat.mjs                           # CLI entry point
├── page.html                          # Prompt API bridge page
└── node_modules/                      # Dependencies
```
