# LLM Bridge for Copilot Chat

将 **Copilot Chat** 路由到任意 **OpenAI 兼容端点**：DeepSeek / MiMo / 本地模型（llama.cpp / Ollama）/ 任意自定义端点。

- **极简配置**：只填 API Key，模型自动出现
- **内置模型**：DeepSeek V4 Pro/Flash、MiMo v2.5 Pro、**MiMo v2.5（原生多模态）**
- **自定义端点**：任意 OpenAI 兼容服务（本地模型走这里）
- 思考模式、工具调用（Agent）、视觉代理（纯文本模型看图）、DeepSeek 余额查询
- 与 **DeepSeek V4 for Copilot** 插件**完全并存**，互不影响
- 上下文默认官方 1M，可逐供应商调整，超出自动截断

> 给 vela / 朋友的迁移说明与开发日志见 `.PrivateDoc/`（不随 VSIX 分发）。

## 配置（只填 Key）

在 `settings.json` 中配置（或用命令 `LLM Bridge: 添加模型（预设）` 引导填写）：

```jsonc
{
  // ✅ DeepSeek（填了才显示 DeepSeek V4 Pro / Flash）
  "llm-bridge.deepseekApiKey": "sk-...",

  // ✅ MiMo（填了才显示 MiMo v2.5 Pro / MiMo v2.5）
  "llm-bridge.mimoApiKey": "tp-...",

  // ✅ 自定义 OpenAI 兼容端点（可选；本地模型也走这里）
  "llm-bridge.openaiBaseUrl": "http://127.0.0.1:8080/v1",
  "llm-bridge.openaiApiKey": "",
  "llm-bridge.openaiModel": "gemma4",

  // ⭕ 可选：上下文窗口（0 = 官方默认 1M，超出自动截断）
  "llm-bridge.deepseekContextWindow": 0,
  "llm-bridge.mimoContextWindow": 0,
  "llm-bridge.openaiContextWindow": 16384,   // 仅自定义端点（0 = 128K）
  "llm-bridge.contextWindow": 0              // 全局覆盖
}
```

## 内置模型（官方参数，自动生成）

| 模型 | 上下文 | 最大输出 | 多模态 | 成本 ¥/1M（命中/输入/输出） |
|---|---|---|---|---|
| DeepSeek V4 Pro | 1M | 384K | ❌ | 0.025 / 3 / 6 |
| DeepSeek V4 Flash | 1M | 384K | ❌ | 0.02 / 1 / 2 |
| MiMo v2.5 Pro | 1M | 128K | ❌ | 0.025 / 3 / 6 |
| **MiMo v2.5** | 1M | 128K | ✅ 原生 | 0.02 / 1 / 2 |
| 自定义 OpenAI | 可调 | 8K | ❌ | — |

## 命令

| 命令 | 说明 |
|---|---|
| `LLM Bridge: 添加模型（预设）` | 选预设（DeepSeek/MiMo/自定义）→ 填 key 即完成 |
| `LLM Bridge: 刷新模型列表` | 改配置后刷新选择器 |
| `LLM Bridge: 查询 DeepSeek 余额` | 查 DeepSeek 账户余额 |
| `LLM Bridge: 配置视觉代理模型` | 指定看图用的视觉模型（默认微软免费模型） |
| `LLM Bridge: 打开模型设置` | 打开设置页 |

## 使用

1. 打开 **Copilot Chat** → 模型选择器 → **LLM Bridge** 分组选模型
2. 思考强度：选模型后点下拉调「关闭/高/最大」
3. 给 **MiMo v2.5** 发图片：直接拖图，**原生解析**（不走代理）
4. 给纯文本模型发图片：自动用视觉代理代看（默认微软免费模型）

## 本地模型（可选，走自定义 OpenAI 槽位）

示例：本地 Gemma 4（llama.cpp，单槽 16384 上下文）
```jsonc
"llm-bridge.openaiBaseUrl": "http://127.0.0.1:8080/v1",
"llm-bridge.openaiModel": "gemma4",
"llm-bridge.openaiContextWindow": 16384
```
启动脚本：`E:\aiPic\models\start-local-llm.ps1`（8GB 显存适配参数）。

## 开发

```bash
npm install          # 安装依赖（已配置 npmmirror 镜像）
npm run compile      # 编译 TypeScript
npx vsce package     # 打包 VSIX
code --install-extension llm-bridge-0.1.0.vsix   # 安装
```

## 致谢与引用

本项目参考并致敬 **Vizards/deepseek-v4-for-copilot**（[GitHub](https://github.com/Vizards/deepseek-v4-for-copilot) / MIT 协议，DeepSeek V4 for Copilot Chat）：

- 采用其 `languageModelChatProviders` 注册机制，让模型出现在 Copilot Chat 模型选择器
- 消息转换、OpenAI 兼容 SSE 流式客户端、思考/工具调用处理思路均参考自该项目
- 本项目为独立精简实现，扩展 ID / vendor / 配置段均与原插件不同，**可并存使用、互不影响**

感谢原插件作者的优秀设计与开源精神。

## 安全说明

API Key 只存在本地 `settings.json`（本机），**VSIX 包内不含任何 key**，可放心分发。请勿将 `settings.json` 提交到公开仓库。
