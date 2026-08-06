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

/** 自定义 OpenAI 兼容端点（一个端点 = 一个 baseUrl + 一个模型）。 */
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
	/** 该端点模型是否支持思考模式（影响发送 thinking / reasoning_effort 参数）。 */
	thinking: boolean;
	/** 是否发送 thinking:{type:'enabled'} + reasoning_effort（DeepSeek 官方等）。 */
	sendThinkingParam: boolean;
	/** 共享 apiKey 的组 id（同一供应商一次勾选的一批模型）；缺省 = 自身 id。 */
	group?: string;
}

/** 极简供应商配置：key 存系统钥匙串（SecretStorage），其余存 settings.json。 */
export interface ProviderSettings {
	endpoints: CustomEndpoint[];
	contextWindow: number;
}

export async function getProviderSettings(context: vscode.ExtensionContext): Promise<ProviderSettings> {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	const endpoints = await parseEndpoints(context, config);
	return {
		endpoints,
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
		// 组 Key 优先（同供应商一批模型共享），其次自身 id 的 Key（旧格式），最后配置内联
		const groupKey = await readApiKey(context, endpointSecretKey(ep.group || ep.id));
		const legacyKey = await readApiKey(context, endpointSecretKey(ep.id));
		ep.apiKey = ep.apiKey || legacyKey || groupKey;
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
				thinking: false,
				sendThinkingParam: false,
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
	thinking?: unknown;
	sendThinkingParam?: unknown;
	group?: unknown;
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
		thinking: e.thinking === true,
		sendThinkingParam: e.sendThinkingParam === true,
		group: str(e.group) || undefined,
	};
}

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
