import * as vscode from 'vscode';

export interface ModelCost {
	/** 输入价格（¥/1M tokens，缓存未命中） */
	input: string;
	/** 输出价格（¥/1M tokens） */
	output: string;
	/** 缓存命中价格（¥/1M tokens） */
	cache: string;
	/** 价格档位（如 low），用于选择器/语言模型页展示 */
	category?: string;
}

export interface ModelConfig {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	thinking: boolean;
	toolCalling: boolean;
	imageInput: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
	contextWindow: number;
	detail?: string;
	sendThinkingParam: boolean;
	/** 成本信息（官网价格），用于 VS Code 语言模型管理页展示 */
	cost?: ModelCost;
}

/** 极简供应商配置：朋友只需要填 key。 */
export interface ProviderSettings {
	deepseekApiKey: string;
	mimoApiKey: string;
	openaiBaseUrl: string;
	openaiApiKey: string;
	openaiModel: string;
	openaiContextWindow: number;
	deepseekContextWindow: number;
	mimoContextWindow: number;
	contextWindow: number;
}

export function getProviderSettings(): ProviderSettings {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	return {
		deepseekApiKey: str(config.get('deepseekApiKey')),
		mimoApiKey: str(config.get('mimoApiKey')),
		openaiBaseUrl: str(config.get('openaiBaseUrl')).replace(/\/+$/, ''),
		openaiApiKey: str(config.get('openaiApiKey')),
		openaiModel: str(config.get('openaiModel')),
		openaiContextWindow: num(config.get('openaiContextWindow')),
		deepseekContextWindow: num(config.get('deepseekContextWindow')),
		mimoContextWindow: num(config.get('mimoContextWindow')),
		contextWindow: num(config.get('contextWindow')),
	};
}

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
