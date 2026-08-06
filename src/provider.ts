import * as vscode from 'vscode';
import { OpenAIClient } from './client';
import { getProviderSettings, type ModelConfig } from './config';
import { buildModels } from './models';
import { convertMessages, convertTools, countMessageChars, safeStringify, type OpenAIMessage } from './convert';
import { trimMessagesToContext } from './context';
import { createVisionDescriberGetter, resolveImageMessages } from './vision';

/**
 * LLM Bridge Chat Provider —— 实现 vscode.LanguageModelChatProvider，
 * 让内置模型（DeepSeek / MiMo / 自定义 OpenAI）出现在 Copilot Chat 模型选择器中。
 */
export class LlmBridgeProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	/** 用于读取 SecretStorage 中的 API Key。 */
	private readonly context: vscode.ExtensionContext;

	/** 自适应 chars-per-token 比率，用于 token 数估算与截断。 */
	private charsPerToken = 4.0;

	/** 扩展是否处于激活状态；卸载时置 false 以便模型从选择器移除。 */
	private isActive = true;

	/** 视觉代理：仅服务于纯文本模型（多模态模型直接原生收图）。 */
	private readonly visionGetter = createVisionDescriberGetter();

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		context.subscriptions.push(this.onDidChangeEmitter);
	}

	/** 强制 Copilot Chat 重新拉取模型列表。 */
	refreshModelPicker(): void {
		this.onDidChangeEmitter.fire();
	}

	/** 视觉代理设置变更后，重置已缓存的视觉模型。 */
	resetVision(): void {
		this.visionGetter.reset();
	}

	/**
	 * 扩展卸载前调用：置为非激活并强制宿主重新拉取模型信息。
	 * 此时 provideLanguageModelChatInformation 返回空列表，Copilot Chat 会立即把
	 * LLM Bridge 模型从选择器移除，避免重载后残留陈旧条目（参考 deepseek-v4-for-copilot）。
	 */
	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.onDidChangeEmitter.fire();
		try {
			// 返回值不使用——只为触发宿主同步重拉 provider 的副作用
			await vscode.lm.selectChatModels({ vendor: 'llm-bridge' });
		} catch {
			// 忽略：卸载清理尽力而为
		}
	}

	private async getModels(): Promise<ModelConfig[]> {
		return buildModels(await getProviderSettings(this.context));
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}
		return (await this.getModels()).map(toChatInfo);
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const cfg = (await this.getModels()).find((m) => m.id === model.id);
		if (!cfg) {
			throw new Error(
				`[LLM Bridge] 未找到模型 ${model.id}：请检查对应供应商的 API Key 是否已配置（设置 → 搜索 llm-bridge）`
			);
		}

		// 多模态模型（如 MiMo v2.5）原生收图，跳过视觉代理；纯文本模型走视觉代理
		let resolvedMessages = messages;
		if (!cfg.imageInput) {
			const resolved = await resolveImageMessages(messages, token, () => this.visionGetter.get());
			resolvedMessages = resolved.messages;
			if (resolved.notice) {
				progress.report(new vscode.LanguageModelTextPart(resolved.notice));
			}
		}

		let apiMessages = convertMessages(resolvedMessages, cfg.imageInput);

		// 读取模型选择器中的"思考强度"（none=关闭 / high=标准 / max=深度）
		const anyOptions = options as unknown as Record<string, unknown>;
		const modelOptions = (anyOptions.modelOptions ??
			anyOptions.modelConfiguration ??
			anyOptions.configuration) as Record<string, unknown> | undefined;
		const rawEffort =
			typeof modelOptions?.reasoningEffort === 'string' ? modelOptions.reasoningEffort : 'high';
		// 归一化到官方支持的档位（DeepSeek 官方枚举 low/high/max；none 用 thinking:disabled 表达）
		const effort: 'none' | 'high' | 'max' =
			rawEffort === 'none' || rawEffort === 'max' ? rawEffort : 'high';

		// 思考模式协议校正（按"实际发送"的 thinking 状态，而非端点配置）：
		// - 开启思考（enabled/passthrough）：history 中每条 assistant 消息都必须携带
		//   reasoning_content 字段（空串即可），否则上游 400
		//   "The `reasoning_content` in the thinking mode must be passed back to the API"；
		//   VS Code 下发历史时通常不含思考内容，因此为缺失该字段的 assistant 消息补空串。
		// - 关闭思考（disabled）：assistant 消息不得携带 reasoning_content，否则同样 400。
		const thinkingMode: ThinkingMode =
			cfg.thinking && effort !== 'none'
				? cfg.sendThinkingParam
					? 'enabled'
					: 'passthrough'
				: 'disabled';
		apiMessages = reconcileReasoningContent(apiMessages, thinkingMode);

		// 上下文截断保护：超出窗口时丢弃最早的消息
		if (cfg.contextWindow > 0) {
			apiMessages = trimMessagesToContext(apiMessages, cfg.contextWindow, this.charsPerToken);
		}

		const tools = cfg.toolCalling ? convertTools(options.tools) : undefined;

		const request = {
			model: cfg.model,
			messages: apiMessages,
			stream: true,
			...(cfg.maxOutputTokens > 0 ? { max_tokens: cfg.maxOutputTokens } : {}),
			...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
			// 思考控制：
			// - 选择器选"关闭" → 一律发送 thinking:{type:'disabled'}（DeepSeek/MiMo 支持则生效；llama.cpp 忽略）
			// - 选择器为 high/max 且 sendThinkingParam=true → 发送 thinking 启用 + reasoning_effort（DeepSeek 官方）
			// - 其余情况不发送 thinking 参数（保持通用兼容）
			...(cfg.thinking
				? effort === 'none'
					? { thinking: { type: 'disabled' as const } }
					: cfg.sendThinkingParam
						? { thinking: { type: 'enabled' as const }, reasoning_effort: effort }
						: {}
				: {}),
		};

		const totalChars = countMessageChars(apiMessages);
		const client = new OpenAIClient(cfg.baseUrl, cfg.apiKey);

		await client.streamChatCompletion(
			request,
			{
				onContent: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
				onThinking: (text) => reportThinkingPart(progress, text),
				onToolCall: (tc) => {
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
					} catch {
						args = {};
					}
					progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args));
				},
				onUsage: (usage) => {
					const promptTokens = usage?.prompt_tokens;
					if (totalChars > 0 && typeof promptTokens === 'number' && promptTokens > 0) {
						const observed = totalChars / promptTokens;
						this.charsPerToken = this.charsPerToken * 0.7 + observed * 0.3;
					}
					// 上报真实 token 用量给 Copilot（mimeType='usage' 的 data part）：
					// 右下角"会话信息"面板的已用 token / 百分比与响应脚注的 "X in, Y out" 都依赖它。
					reportUsagePart(progress, usage);
				},
				onError: (error) => {
					throw new Error(`[LLM Bridge] ${cfg.name} 请求失败：${error.message}`);
				},
				onDone: () => {
					// 无需额外处理
				},
			},
			token
		);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		return Math.ceil(estimateMessageChars(text) / this.charsPerToken);
	}
}

/** 实际发送的 thinking 状态（决定 assistant 历史消息的 reasoning_content 如何校正）。 */
export type ThinkingMode = 'enabled' | 'disabled' | 'passthrough';

/**
 * 思考模式协议校正：按实际发送的 thinking 状态统一处理 assistant 历史消息的 reasoning_content。
 * - enabled：DeepSeek 思考模式下要求每条 assistant 历史消息都必须带该字段（空串即可），
 *   否则 400：The `reasoning_content` in the thinking mode must be passed back to the API.
 * - disabled：思考关闭时 assistant 消息不得携带 reasoning_content，否则同样 400。
 * - passthrough：未发送 thinking 参数（保持通用兼容），字段原样保留。
 */
export function reconcileReasoningContent(
	messages: OpenAIMessage[],
	mode: ThinkingMode
): OpenAIMessage[] {
	return messages.map((m) => {
		if (m.role !== 'assistant') {
			return m;
		}
		if (mode === 'enabled' && m.reasoning_content === undefined) {
			return { ...m, reasoning_content: '' };
		}
		if (mode === 'disabled' && m.reasoning_content !== undefined) {
			const rest: OpenAIMessage = { ...m };
			delete rest.reasoning_content;
			return rest;
		}
		return m;
	});
}

function toChatInfo(m: ModelConfig): vscode.LanguageModelChatInformation {
	const detail = buildDetail(m);
	return {
		id: m.id,
		name: m.name,
		family: 'llm-bridge',
		version: '',
		detail,
		tooltip: detail,
		// 提案字段（运行时透传，参考 deepseek-v4-for-copilot）：
		// isBYOK 标记为用户自带 Key 的模型，isUserSelectable 表示允许在模型选择器中手动选择
		isBYOK: true,
		isUserSelectable: true,
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		capabilities: {
			toolCalling: m.toolCalling,
			imageInput: m.imageInput,
		},
		// 成本元数据：供 VS Code 内置"语言模型"管理页展示（inputCost/outputCost/cacheCost 为运行时字段）
		...(m.cost
			? {
					inputCost: m.cost.input,
					outputCost: m.cost.output,
					cacheCost: m.cost.cache,
					...(m.cost.category ? { priceCategory: m.cost.category } : {}),
				}
			: {}),
		// configurationSchema 属提案 API：运行时若支持，会在选择器中显示"思考强度"
		...(m.thinking ? { configurationSchema: buildThinkingSchema() } : {}),
	} as vscode.LanguageModelChatInformation;
}

/** 动态组装选择器说明文字：基础描述 + 当前生效的上下文。 */
function buildDetail(m: ModelConfig): string | undefined {
	const ctx = formatTokens(m.maxInputTokens);
	return m.detail ? `${m.detail} · 上下文 ${ctx}` : `上下文 ${ctx}`;
}

function formatTokens(n: number): string {
	if (n >= 1000000) {
		return n % 1000000 === 0 ? `${n / 1000000}M` : `${(n / 1000000).toFixed(1)}M`;
	}
	if (n >= 1000) {
		return `${Math.round(n / 1000)}K`;
	}
	return String(n);
}

/** 思考强度选择器（是否生效取决于端点是否支持）。 */
function buildThinkingSchema(): unknown {
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: '思考强度',
				enum: ['none', 'high', 'max'],
				enumItemLabels: ['关闭', '高', '最大'],
				enumDescriptions: ['关闭思考', '平衡（默认）', '深度推理'],
				default: 'high',
				group: 'navigation',
			},
		},
	};
}

function reportThinkingPart(progress: vscode.Progress<vscode.LanguageModelResponsePart>, text: string): void {
	const ctor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
	if (typeof ctor === 'function') {
		progress.report(new (ctor as new (value: string) => object)(text) as vscode.LanguageModelResponsePart);
	}
}

/** Copilot 识别 token 用量数据 part 的 mimeType（与 VS Code 内置 BYOK provider 一致）。 */
const USAGE_DATA_PART_MIME = 'usage';

/**
 * 通过 LanguageModelDataPart 把真实 token 用量上报给 Copilot Chat。
 *
 * 参考 deepseek-v4-for-copilot 的 reportCopilotContextUsage：VS Code 扩展宿主收到
 * mimeType 为 'usage' 的 data part 后解析为内部 APIUsage（{prompt_tokens, completion_tokens,
 * total_tokens, prompt_tokens_details:{cached_tokens}}），据此驱动：
 * - 聊天面板右下角"会话信息"（Session Info）面板：已用 token / 总上下文百分比；
 * - 响应脚注的 "X in, Y out" 用量展示。
 * 不发送此 part 时 VS Code 拿不到真实用量，会话信息面板会被隐藏、脚注无 token 统计。
 */
export function reportUsagePart(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	usage: Record<string, unknown> | undefined
): void {
	if (!usage) {
		return;
	}
	const prompt = toNonNegativeInt(usage.prompt_tokens);
	const completion = toNonNegativeInt(usage.completion_tokens);
	if (prompt === undefined && completion === undefined) {
		return;
	}
	// 兼容两种缓存字段：OpenAI 风格 prompt_tokens_details.cached_tokens，DeepSeek 风格 prompt_cache_hit_tokens
	const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
	const cached = toNonNegativeInt(details?.cached_tokens) ?? toNonNegativeInt(usage.prompt_cache_hit_tokens) ?? 0;
	const data = {
		prompt_tokens: prompt ?? 0,
		completion_tokens: completion ?? 0,
		total_tokens: toNonNegativeInt(usage.total_tokens) ?? (prompt ?? 0) + (completion ?? 0),
		prompt_tokens_details: { cached_tokens: cached },
	};
	try {
		progress.report(
			new vscode.LanguageModelDataPart(Buffer.from(JSON.stringify(data)), USAGE_DATA_PART_MIME)
		);
	} catch {
		// 运行时 API 不支持该 part 时静默忽略，不影响主流程
	}
}

function toNonNegativeInt(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

/** 单张图片的估算字符数（约 250 tokens）：避免把 base64 原样算进 token 导致严重高估。 */
const IMAGE_PART_ESTIMATED_CHARS = 1000;
/** 非图片二进制附件（如 PDF）的字符数上限。 */
const MAX_BINARY_PART_CHARS = 10000;

/**
 * 估算一条消息/文本的字符数，用于 provideTokenCount。
 * 图片等二进制 part 用固定估算值，而不是序列化后的 base64 长度（多模态模型原生收图时
 * 旧实现会把整段 base64 算进 token，一张 1MB 图约高估到几十万 token）。
 */
export function estimateMessageChars(text: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof text === 'string') {
		return text.length;
	}
	let total = 0;
	for (const part of text.content) {
		if (typeof part === 'string') {
			total += part.length;
		} else if (part instanceof vscode.LanguageModelTextPart) {
			total += part.value.length;
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			total += part.name.length + safeStringify(part.input).length;
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			for (const item of part.content) {
				total += estimatePartChars(item);
			}
		} else {
			total += estimatePartChars(part);
		}
	}
	return total;
}

function estimatePartChars(part: unknown): number {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value.length;
	}
	if (isDataPart(part)) {
		return part.mimeType.startsWith('image/')
			? IMAGE_PART_ESTIMATED_CHARS
			: Math.min(part.data.byteLength, MAX_BINARY_PART_CHARS);
	}
	if (isThinkingPart(part)) {
		const value = (part as { value: unknown }).value;
		if (Array.isArray(value)) {
			return value.reduce((sum, v) => sum + String(v).length, 0);
		}
		return typeof value === 'string' ? value.length : 0;
	}
	return 0;
}

function isDataPart(part: unknown): part is vscode.LanguageModelDataPart {
	return (
		typeof vscode.LanguageModelDataPart === 'function' &&
		part instanceof vscode.LanguageModelDataPart
	);
}

function isThinkingPart(part: unknown): boolean {
	const ctor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
	return typeof ctor === 'function' && part instanceof (ctor as new (...args: never[]) => object);
}
