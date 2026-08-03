# Changelog

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
