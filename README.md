# LLM Bridge for Copilot Chat

将 **Copilot Chat** 路由到任意 **OpenAI 兼容端点**：DeepSeek、MiMo、OpenCode Zen / Go、OpenRouter，以及本地模型（llama.cpp / Ollama / LM Studio）等任意自定义端点。

## 特性

- **零配置预设**：DeepSeek、MiMo（Token Plan / 官方 API）、OpenCode Zen / Go、OpenRouter，填 Key 即用
- **统一流程**：所有预设/自定义端点，填 Key 后**自动拉取模型列表、勾选多个即用**
- 思考模式（强度可调）、工具调用（Agent）、视觉代理（透明，自动选已装视觉模型）、余额查询
- 上下文窗口可逐供应商配置，超出自动截断
- 与 **DeepSeek V4 for Copilot** 插件**完全并存**（模型 ID 带 `custom-` 前缀，不冲突）

## 快速开始

1. 命令面板（`Ctrl+Shift+P`）→ **「LLM Bridge: 添加模型（预设）」**
2. 选择预设 → 填入 API Key（安全存入**系统钥匙串**）→ **勾选要使用的模型**（可多选）
3. 打开 **Copilot Chat** → 模型选择器 → **LLM Bridge** 分组选模型

### 预设

| 预设 | baseUrl | 计费 | Key 格式 |
|---|---|---|---|
| DeepSeek 官方 | `https://api.deepseek.com/v1` | 按量付费 | `sk-...` |
| MiMo Token Plan | `https://token-plan-cn.xiaomimimo.com/v1` | 订阅套餐 | `tp-...` |
| MiMo 官方 API | `https://api.xiaomimimo.com/v1` | 按量付费 | `sk-...` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | 按量付费 | `oc-...` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | 订阅 $10/月 | `oc-...` |
| OpenRouter | `https://openrouter.ai/api/v1` | 按量付费 | `sk-or-...` |
| 自定义端点 | 任意 OpenAI 兼容地址 | — | 任意 |

> 所有预设流程**完全一致**：填 Key → 自动拉取 `/models` → **勾选要使用的模型**（可多选）→ 设置上下文。供应商更新模型后，用「LLM Bridge: 管理模型」刷新即可看到新模型。

## 配置

以下配置为**可选微调**，日常使用命令即可。所有 Key 统一存**系统钥匙串**（SecretStorage），不写入 `settings.json`。

```jsonc
{
  // ✅ 自定义 OpenAI 兼容端点（支持多个：本地 llama.cpp + 云端第三方并存）
  "llm-bridge.endpoints": [
    {
      "id": "local-gemma",
      "name": "本地 Gemma 4",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "gemma4",
      "contextWindow": 16384  // 可选：上下文窗口（tokens），0/缺省 = 默认 128K
      // 本地端点无需 apiKey；云端端点的 Key 推荐用命令填写（存钥匙串）
    }
  ],

  // ⭕ 可选：全局上下文覆盖（0 = 各端点默认 128K，超出自动截断）
  "llm-bridge.contextWindow": 0
}
```

## 模型与注册 ID

所有模型都来自**端点配置**（`llm-bridge.endpoints`），无"内置模型"：同一供应商勾选的多个模型共享一个 Key（`group`）。模型注册 ID 为 `custom-<id>`，发送给 API 的 `model` 名不变。

- 端点模型若支持**思考模式**（如 DeepSeek 官方），模型选择器会出现「思考强度」下拉（关闭 / 高 / 最大），发送的参数符合官方枚举（`thinking` + `reasoning_effort`）
- 端点模型若**支持多模态**（如 MiMo v2.5），图片直接原生解析，不走视觉代理
- 与 **DeepSeek V4 for Copilot** 插件**完全并存**（注册 ID 带 `custom-` 前缀，不冲突）

## 命令

| 命令 | 说明 |
|---|---|
| `LLM Bridge: 添加模型（预设）` | 选择预设 → 填 Key → **勾选要使用的模型**（统一流程） |
| `LLM Bridge: 管理模型` | 按供应商分组管理：**刷新模型列表**（重新拉取并勾选最新模型）/ 删除单个模型 / 删除分组 |
| `LLM Bridge: 刷新模型列表` | 改配置后刷新选择器 |
| `LLM Bridge: 查询余额` | 查任意已配置账户余额（DeepSeek 风格 `/user/balance`、OpenRouter `/credits`） |
| `LLM Bridge: 配置视觉代理模型` | 指定看图用的视觉模型（留空自动选已安装的第一个可用视觉模型） |
| `LLM Bridge: 打开模型设置` | 打开设置页 |

## 使用技巧

- **思考强度**：选择模型后，用下拉调整「关闭 / 高 / 最大」（发送参数符合官方枚举）
- **原生多模态**：给**支持多模态的模型**（如 MiMo v2.5）发图片，直接拖入即可（不走代理）
- **透明视觉代理**：纯文本模型收到图片时，自动交给已安装的视觉模型描述后再转发（参考 DeepSeek V4 for Copilot 方案；可用命令自选视觉模型）

## 本地模型（可选）

本地 llama.cpp / Ollama / LM Studio 走**自定义端点**，无需 Key：

```jsonc
"llm-bridge.endpoints": [
  {
    "id": "local-gemma",
    "name": "本地 Gemma 4",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "gemma4",
    "contextWindow": 16384
  }
]
```

## 开发

```bash
npm install          # 安装依赖（已配置 npmmirror 镜像）
npm run compile      # 编译 TypeScript
npm test             # 运行单元测试（vitest）
npx vsce package     # 打包 VSIX
code --install-extension llm-bridge-0.2.0.vsix   # 安装
```

## 致谢与引用

本项目参考并致敬 **Vizards/deepseek-v4-for-copilot**（[GitHub](https://github.com/Vizards/deepseek-v4-for-copilot) / MIT 协议，DeepSeek V4 for Copilot Chat）：

- 采用其 `languageModelChatProviders` 注册机制，让模型出现在 Copilot Chat 模型选择器
- 消息转换、OpenAI 兼容 SSE 流式客户端、思考/工具调用处理思路均参考自该项目
- 本项目为独立精简实现，扩展 ID / vendor / 配置段均与原插件不同，**可并存使用、互不影响**

感谢原插件作者的优秀设计与开源精神。

## AI 声明

本项目在开发过程中使用了大语言模型（DeepSeek）辅助完成编码、测试与文档撰写。

## 安全说明

API Key 存于**系统钥匙串**（SecretStorage），不落盘明文。
