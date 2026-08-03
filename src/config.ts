import * as vscode from 'vscode';
import { SECRET_KEYS, endpointSecretKey, readApiKey } from './keys';

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

/** 自定义 OpenAI 兼容端点。 */
export interface CustomEndpoint {
	/** 端点唯一 id（用于在 SecretStorage 中关联 apiKey）。 */
	id: string;
	/** 显示名称。 */
	name: string;
	baseUrl: string;
	/** 解析后的 apiKey（来自 SecretStorage 或配置内联；本地端点可为空）。 */
	apiKey: string;
	model: string;
	contextWindow: number;
	toolCalling: boolean;
	imageInput: boolean;
}

/** 极简供应商配置：key 存系统钥匙串（SecretStorage），其余存 settings.json。 */
export interface ProviderSettings {
	deepseekApiKey: string;
	mimoApiKey: string;
	endpoints: CustomEndpoint[];
	deepseekContextWindow: number;
	mimoContextWindow: number;
	contextWindow: number;
}

export async function getProviderSettings(context: vscode.ExtensionContext): Promise<ProviderSettings> {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	const deepseekApiKey = await readApiKey(context, SECRET_KEYS.deepseek, 'deepseekApiKey');
	const mimoApiKey = await readApiKey(context, SECRET_KEYS.mimo, 'mimoApiKey');
	const endpoints = await parseEndpoints(context, config);
	return {
		deepseekApiKey,
		mimoApiKey,
		endpoints,
		deepseekContextWindow: num(config.get('deepseekContextWindow')),
		mimoContextWindow: num(config.get('mimoContextWindow')),
		contextWindow: num(config.get('contextWindow')),
	};
}

async function parseEndpoints(
	context: vscode.ExtensionContext,
	config: vscode.WorkspaceConfiguration
): Promise<CustomEndpoint[]> {
	const raw = config.get<unknown[]>('endpoints', []);
	const endpoints: CustomEndpoint[] = [];
	for (const item of raw) {
		const ep = normalizeEndpoint(item);
		if (!ep) {
			continue;
		}
		const secret = await readApiKey(context, endpointSecretKey(ep.id));
		ep.apiKey = ep.apiKey || secret;
		endpoints.push(ep);
	}
	// 兼容旧版单槽配置：endpoints 为空但 openaiBaseUrl + openaiModel 已填时，自动转换为一个端点
	if (endpoints.length === 0) {
		const baseUrl = str(config.get('openaiBaseUrl')).replace(/\/+$/, '');
		const model = str(config.get('openaiModel'));
		if (baseUrl && model) {
			const legacyKey = await readApiKey(context, SECRET_KEYS.openai, 'openaiApiKey');
			endpoints.push({
				id: 'legacy-custom',
				name: '自定义 OpenAI',
				baseUrl,
				apiKey: legacyKey,
				model,
				contextWindow: num(config.get('openaiContextWindow')),
				toolCalling: true,
				imageInput: false,
			});
		}
	}
	return endpoints;
}

interface RawEndpoint {
	id?: unknown;
	name?: unknown;
	baseUrl?: unknown;
	apiKey?: unknown;
	model?: unknown;
	contextWindow?: unknown;
	toolCalling?: unknown;
	imageInput?: unknown;
}

function normalizeEndpoint(raw: unknown): CustomEndpoint | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const e = raw as RawEndpoint;
	const baseUrl = str(e.baseUrl).replace(/\/+$/, '');
	const model = str(e.model);
	if (!baseUrl || !model) {
		return null;
	}
	const id = str(e.id) || `custom-${baseUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '-')}`;
	return {
		id,
		name: str(e.name) || model,
		baseUrl,
		apiKey: str(e.apiKey),
		model,
		contextWindow: num(e.contextWindow),
		toolCalling: e.toolCalling === undefined ? true : Boolean(e.toolCalling),
		imageInput: e.imageInput === true,
	};
}

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
