import type { ModelConfig, ModelCost, ProviderSettings } from './config';

/**
 * 模型生成：从已配置端点生成模型槽位。
 * 每个端点（一个 baseUrl + 一个 model）生成一个模型，出现在 Copilot Chat 选择器。
 */
export function buildModels(s: ProviderSettings): ModelConfig[] {
	const models: ModelConfig[] = [];
	for (const ep of s.endpoints) {
		const ctx = ep.contextWindow > 0 ? ep.contextWindow : 131072;
		models.push(
			makeModel({
				id: `custom-${ep.id}`,
				name: ep.name,
				baseUrl: ep.baseUrl,
				apiKey: ep.apiKey,
				model: ep.model,
				thinking: ep.thinking,
				imageInput: ep.imageInput,
				maxInputTokens: ctx,
				maxOutputTokens: 8192,
				detail: `${ep.name} · ${ep.baseUrl}`,
				sendThinkingParam: ep.sendThinkingParam,
				toolCalling: ep.toolCalling,
			})
		);
	}
	// 全局上下文覆盖（0 = 各端点默认 128K）
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
