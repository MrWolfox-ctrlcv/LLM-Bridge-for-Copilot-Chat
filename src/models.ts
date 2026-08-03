import type { ModelConfig, ModelCost, ProviderSettings } from './config';

/**
 * 内置模型槽位：根据用户填的 key 自动生成。
 * 各模型参数均按官方文档设定（上下文 1M / 输出 128K）。
 */
export function buildModels(s: ProviderSettings): ModelConfig[] {
	const models: ModelConfig[] = [];

	if (s.deepseekApiKey) {
		models.push(
			makeModel({
				id: 'deepseek-v4-pro',
				name: 'DeepSeek V4 Pro',
				baseUrl: 'https://api.deepseek.com/v1',
				apiKey: s.deepseekApiKey,
				model: 'deepseek-v4-pro',
				thinking: true,
				imageInput: false,
				maxInputTokens: 1000000,
				maxOutputTokens: 393216,
				detail: 'DeepSeek 官方 V4 Pro',
				sendThinkingParam: true,
				cost: { input: '\u00a53', output: '\u00a56', cache: '\u00a50.025', category: 'low' },
			}),
			makeModel({
				id: 'deepseek-v4-flash',
				name: 'DeepSeek V4 Flash',
				baseUrl: 'https://api.deepseek.com/v1',
				apiKey: s.deepseekApiKey,
				model: 'deepseek-v4-flash',
				thinking: true,
				imageInput: false,
				maxInputTokens: 1000000,
				maxOutputTokens: 393216,
				detail: 'DeepSeek 官方 V4 Flash',
				sendThinkingParam: true,
				cost: { input: '\u00a51', output: '\u00a52', cache: '\u00a50.02', category: 'low' },
			})
		);
	}

	if (s.mimoApiKey) {
		models.push(
			makeModel({
				id: 'mimo-v2.5-pro',
				name: 'MiMo v2.5 Pro',
				baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
				apiKey: s.mimoApiKey,
				model: 'mimo-v2.5-pro',
				thinking: true,
				imageInput: false,
				maxInputTokens: 1000000,
				maxOutputTokens: 131072,
				detail: '小米 MiMo v2.5 Pro',
				sendThinkingParam: false,
				cost: { input: '\u00a53', output: '\u00a56', cache: '\u00a50.025' },
			}),
			makeModel({
				id: 'mimo-v2.5',
				name: 'MiMo v2.5',
				baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
				apiKey: s.mimoApiKey,
				model: 'mimo-v2.5',
				thinking: true,
				imageInput: true, // 原生多模态：图片直接以 base64 发给它
				maxInputTokens: 1000000,
				maxOutputTokens: 131072,
				detail: '小米 MiMo v2.5 · 原生多模态',
				sendThinkingParam: false,
				cost: { input: '\u00a51', output: '\u00a52', cache: '\u00a50.02' },
			})
		);
	}

	// 自定义 OpenAI 兼容端点：支持多个（llm-bridge.endpoints 数组），apiKey 可留空（本地端点如 llama.cpp 无需鉴权）
	for (const ep of s.endpoints) {
		const ctx = ep.contextWindow > 0 ? ep.contextWindow : 131072;
		models.push(
			makeModel({
				id: `custom-${ep.id}`,
				name: ep.name,
				baseUrl: ep.baseUrl,
				apiKey: ep.apiKey,
				model: ep.model,
				thinking: false,
				imageInput: ep.imageInput,
				maxInputTokens: ctx,
				maxOutputTokens: 8192,
				detail: `${ep.name} · 自定义端点`,
				sendThinkingParam: false,
				toolCalling: ep.toolCalling,
			})
		);
	}

	// 各供应商上下文覆盖（0 = 官方默认 1M）
	applyContextOverride(models, (m) => m.id.startsWith('deepseek-'), s.deepseekContextWindow);
	applyContextOverride(models, (m) => m.id.startsWith('mimo-'), s.mimoContextWindow);

	// 全局上下文覆盖（0 = 各模型官方默认）
	applyContextOverride(models, () => true, s.contextWindow);

	return models;
}

function applyContextOverride(
	models: ModelConfig[],
	match: (m: ModelConfig) => boolean,
	contextWindow: number
): void {
	if (contextWindow <= 0) {
		return;
	}
	for (const m of models) {
		if (match(m)) {
			m.maxInputTokens = contextWindow;
			m.contextWindow = contextWindow;
		}
	}
}

interface ModelArgs {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	thinking: boolean;
	imageInput: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	detail: string;
	sendThinkingParam: boolean;
	/** 覆盖默认工具调用能力（默认 true）。 */
	toolCalling?: boolean;
	cost?: ModelCost;
}

function makeModel(a: ModelArgs): ModelConfig {
	return {
		...a,
		toolCalling: a.toolCalling ?? true,
		contextWindow: a.maxInputTokens,
	};
}
