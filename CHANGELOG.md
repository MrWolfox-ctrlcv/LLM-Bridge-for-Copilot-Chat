# Changelog

## [0.3.5] - 2026-08-06

### 功能
- **上报真实 token 用量给 Copilot Chat**：通过 `mimeType='usage'` 的数据 part 上报每次请求的 token 数，聊天面板右下角「会话信息」面板显示已用/总 token 与百分比，响应脚注显示 "X in, Y out"（此前面板不工作、脚注无统计）
- 模型元数据增加 `isBYOK` / `isUserSelectable`（Copilot 模型选择器按"用户自带 Key"模型处理）
- 扩展卸载/重载时主动清理模型选择器，不再残留陈旧模型条目
- 激活时先激活 Copilot Chat 再刷新模型选择器，思考强度等配置立即生效
- 多窗口同步：另一窗口增删 API Key 时本窗口模型选择器自动刷新
- 修复 `provideTokenCount` 对图片消息的 token 估算严重失真（base64 不再计入，改用固定估算）
- 接通 DeepSeek 官方价格表（`cost` 字段），VS Code「语言模型管理页」显示价格

### 其他
- 新增单元测试（usage 上报 + token 估算），共 48 例

## [0.3.0] - 2026-08-06

### 功能
- **统一端点流程重构**：移除内置模型，所有模型均来自端点配置（`llm-bridge.endpoints`）
- 所有预设流程统一：填 Key → 自动拉取 `/models` → **勾选要使用的模型（可多选）** → 设置上下文
- 新增命令「LLM Bridge: 管理模型」：按供应商分组管理，支持刷新模型列表 / 删除单个模型 / 删除分组
- 新增预设：OpenCode Zen / Go、OpenRouter
- 思考强度支持官方参数（`thinking` + `reasoning_effort`）：关闭 / 高 / 最大
- 端点配置新增 `thinking`、`sendThinkingParam`、`group` 字段；支持原生多模态模型直接解析图片

### 其他
- 模型注册 ID 改为 `custom-<id>`，发送给 API 的 `model` 名不变（与 DeepSeek V4 for Copilot 插件不冲突）

## [0.2.0] - 2026-08-03

### 安全（重要）
- API Key 改为存入系统钥匙串（`SecretStorage`），不再明文写入 `settings.json`
- 启动时自动迁移旧版 `settings.json` 中已填写的 key 到钥匙串，并清空配置项

### 功能
- **支持多个自定义 OpenAI 兼容端点**（`llm-bridge.endpoints` 数组），本地模型与云端第三方可并存
- 每个端点独立 `baseUrl` / `model` / `contextWindow` / `toolCalling` / `imageInput`，云端 Key 按端点存入钥匙串
- 命令「LLM Bridge: 添加模型（预设）」新增自定义端点引导（自动生成 id，Key 存钥匙串）

### 其他
- 迁移 `moduleResolution` 到 `node16`，消除 TypeScript 弃用警告
- 修复：自定义端点留空 API Key 时模型不显示的问题
- 新增单元测试（vitest，27 例）；`.vscodeignore` 排除测试目录

## [0.1.0] - 初始版本
