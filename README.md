# LLM Bridge for Copilot Chat

**[中文](./README.zh-CN.md) · English**

Route **Copilot Chat** to any **OpenAI-compatible endpoint**: DeepSeek, MiMo, OpenCode Zen / Go, OpenRouter, or local models (llama.cpp / Ollama / LM Studio) and any other custom endpoint.

## Features

- **Zero-config presets**: DeepSeek, MiMo (Token Plan / Official API), OpenCode Zen / Go, OpenRouter — just paste your key and go
- **Unified flow**: for presets and custom endpoints alike, it **auto-fetches the model list** after you enter a key — check the ones you want and you're done
- Thinking mode (adjustable effort), tool calling (Agent), a transparent vision proxy (auto-picks an installed vision model for text-only models), and balance queries
- Per-provider context windows with automatic truncation when exceeded
- **Fully coexists with the DeepSeek V4 for Copilot** extension (registered model IDs use a `custom-` prefix, so there is no conflict)

## Quick Start

1. Command Palette (`Ctrl+Shift+P`) → **「LLM Bridge: Add Model (Preset)」**
2. Pick a preset → enter your API Key (securely stored in the **system keychain**) → **check the models** you want to use (multi-select)
3. Open **Copilot Chat** → model picker → select a model under the **LLM Bridge** group

### Presets

| Preset | baseUrl | Billing | Key format |
|---|---|---|---|
| DeepSeek Official | `https://api.deepseek.com/v1` | Pay-as-you-go | `sk-...` |
| MiMo Token Plan | `https://token-plan-cn.xiaomimimo.com/v1` | Subscription | `tp-...` |
| MiMo Official API | `https://api.xiaomimimo.com/v1` | Pay-as-you-go | `sk-...` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | Pay-as-you-go | `oc-...` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | Subscription $10/mo | `oc-...` |
| OpenRouter | `https://openrouter.ai/api/v1` | Pay-as-you-go | `sk-or-...` |
| Custom endpoint | Any OpenAI-compatible URL | — | Any |

> Every preset follows the exact same flow: enter key → auto-fetch `/models` → **check the models** (multi-select) → set context. When a provider adds models, use **「LLM Bridge: Manage Models」** to refresh and see them.

## Configuration

The settings below are **optional tweaks**; everyday use only needs the commands. All keys are stored in the **system keychain** (SecretStorage) and never written to `settings.json` in plaintext.

```jsonc
{
  // ✅ Custom OpenAI-compatible endpoints (multiple allowed: local llama.cpp + cloud in parallel)
  "llm-bridge.endpoints": [
    {
      "id": "local-gemma",
      "name": "Local Gemma 4",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "gemma4",
      "contextWindow": 16384  // optional: context window (tokens); 0/omitted = default 128K
      // Local endpoints need no apiKey; for cloud endpoints, prefer the command to store the key (keychain)
    }
  ],

  // ⭕ Optional: global context window override (0 = 128K default per endpoint, auto-truncate when exceeded)
  "llm-bridge.contextWindow": 0
}
```

## Models & Registered IDs

All models come from **endpoint configuration** (`llm-bridge.endpoints`) — there are no "built-in models": multiple checked models from the same provider share one key (`group`). Registered model IDs are `custom-<id>`; the `model` name sent to the API is unchanged.

- If an endpoint model supports **thinking mode** (e.g. DeepSeek Official), the model picker shows a **Reasoning Effort** dropdown (Off / High / Max), sending the official parameters (`thinking` + `reasoning_effort`)
- If an endpoint model supports **multimodal input** (e.g. MiMo v2.5), images are parsed natively and skip the vision proxy
- **Fully coexists with the DeepSeek V4 for Copilot** extension (registered IDs use the `custom-` prefix, no conflict)

## Commands

| Command | Description |
|---|---|
| `LLM Bridge: Add Model (Preset)` | Pick a preset → enter key → **check the models to use** (unified flow) |
| `LLM Bridge: Manage Models` | Grouped management by provider: **refresh model list** (re-fetch and check latest) / delete a single model / delete a group |
| `LLM Bridge: Test Connection` | Pick an endpoint and test connectivity (verifies network + auth, shows available models) |
| `LLM Bridge: Refresh Model List` | Refresh the picker after editing config |
| `LLM Bridge: Check Balance` | Query balance of any configured account (DeepSeek-style `/user/balance`, OpenRouter `/credits`) |
| `LLM Bridge: Configure Vision Model` | Choose which installed vision model handles images (leave empty to auto-pick the first available one) |
| `LLM Bridge: Open Settings` | Open the settings page |

## Tips

- **Reasoning effort**: after selecting a model, use the dropdown to adjust Off / High / Max (parameters follow the official enum)
- **Native multimodal**: send images directly to **multimodal models** (e.g. MiMo v2.5) by dragging them in (no proxy involved)
- **Transparent vision proxy**: when a text-only model receives images, they are automatically described by an installed vision model before being forwarded (based on the DeepSeek V4 for Copilot approach; you can pick the vision model via the command)

## Local Models (Optional)

Local llama.cpp / Ollama / LM Studio use a **custom endpoint** with no key required:

```jsonc
"llm-bridge.endpoints": [
  {
    "id": "local-gemma",
    "name": "Local Gemma 4",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "gemma4",
    "contextWindow": 16384
  }
]
```

## Development

```bash
npm install          # install dependencies (npmmirror mirror configured)
npm run compile      # compile TypeScript
npm test             # run unit tests (vitest)
npx vsce package     # package the VSIX
code --install-extension llm-bridge-0.3.0.vsix   # install
```

## Credits & References

This project references and pays tribute to **Vizards/deepseek-v4-for-copilot** ([GitHub](https://github.com/Vizards/deepseek-v4-for-copilot) / MIT, DeepSeek V4 for Copilot Chat):

- Uses its `languageModelChatProviders` registration mechanism so models appear in the Copilot Chat model picker
- Message conversion, the OpenAI-compatible SSE streaming client, and thinking/tool-calling handling are inspired by that project
- This project is an independent, slimmed-down implementation; extension ID / vendor / config section differ from the original, so **both can coexist without interference**

Thanks to the original author for the great design and open-source spirit.

## AI Disclosure

Large language models (DeepSeek) assisted with coding, testing, and documentation during the development of this project.

## Security

API keys are stored in the **system keychain** (SecretStorage) and never persisted in plaintext.
