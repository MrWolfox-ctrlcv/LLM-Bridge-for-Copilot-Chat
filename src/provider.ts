import * as vscode from 'vscode';
import { OpenAIClient } from './client';
import { getProviderSettings, type ModelConfig } from './config';
import { buildModels } from './models';
import { convertMessages, convertTools, countMessageChars, messageChars } from './convert';
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

	private async getModels(): Promise<ModelConfig[]> {
		return buildModels(await getProviderSettings(this.context));
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
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

		// 上下文截断保护：超出窗口时丢弃最早的消息
		if (cfg.contextWindow > 0) {
			apiMessages = trimMessagesToContext(apiMessages, cfg.contextWindow, this.charsPerToken);
		}

		const tools = cfg.toolCalling ? convertTools(options.tools) : undefined;

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
		const str = typeof text === 'string' ? text : JSON.stringify(text);
		return Math.ceil(str.length / this.charsPerToken);
	}
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
