import * as vscode from 'vscode';
import { OpenAIClient } from './client';
import { getProviderSettings, type CustomEndpoint } from './config';

export interface VisionImage {
	mimeType: string;
	data: Uint8Array;
}

export interface VisionDescriber {
	readonly id: string;
	describe(request: {
		prompt: string;
		images: VisionImage[];
		token: vscode.CancellationToken;
	}): Promise<string>;
}

const IMAGE_DESCRIPTION_PROMPT =
	'Describe all image attachments in this message.\n\n' +
	'If there is one image, describe it directly.\n' +
	'If there are multiple images:\n' +
	'1. Describe each image separately, preserving their order.\n' +
	'2. Then provide a combined description explaining the overall context and relationships across the images.\n\n' +
	'Return one concise factual description suitable for inserting into a text-only chat prompt. Include visible text, objects, UI elements, people, and relevant context. Do not invent details.';

const IMAGE_DESCRIPTION_PREFIX = '[Image Description: ';
const IMAGE_DESCRIPTION_SUFFIX = ']';
export const IMAGE_DESCRIPTION_UNAVAILABLE = '[Image Description unavailable]';

/**
 * 不用于代看图片的供应商/模型。
 * 注意：`llm-bridge` 自己的多模态模型（imageInput=true，如 MiMo v2.5）完全可以用作视觉代理，
 * 故不再整段排除该 vendor——`isVisionModel` 已用 `capabilities.imageInput` 挡住纯文本模型防止循环。
 */
const EXCLUDED_VENDORS = new Set(['deepseek', 'claude-code', 'copilotcli']);
const EXCLUDED_IDS = new Set(['copilot-utility', 'copilot-utility-small']);

export interface VisionModelOption {
	/** 形如 vendor/id 的唯一键 */
	key: string;
	vendor: string;
	id: string;
	name: string;
	family: string;
	/** 该模型是否为 llm-bridge 自己配置的多模态端点（imageInput=true）。 */
	bridge?: boolean;
	/** bridge 端点的配置信息（用于直接调自己的 OpenAI 客户端）。 */
	endpoint?: CustomEndpoint;
}

function modelKey(m: { vendor: string; id: string }): string {
	return `${m.vendor}/${m.id}`;
}

/**
 * 列出所有可用的视觉模型：
 * 1. llm-bridge 自己配置的 imageInput=true 端点（最可靠，直接走自己的 OpenAI 客户端看图，不依赖 VS Code 能力上报）；
 * 2. 宿主（Copilot Chat）上报的视觉模型（尽力而为，capabilities 运行时读取）。
 */
export async function listVisionModelOptions(context: vscode.ExtensionContext): Promise<VisionModelOption[]> {
	const options: VisionModelOption[] = [];
	const seen = new Set<string>();
	// 1) 自己的多模态端点
	const settings = await getProviderSettings(context);
	for (const ep of settings.endpoints) {
		if (!ep.imageInput) {
			continue;
		}
		const id = `custom-${ep.id}`;
		const key = `llm-bridge/${id}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		options.push({
			key,
			vendor: 'llm-bridge',
			id,
			name: ep.name,
			family: 'llm-bridge',
			bridge: true,
			endpoint: ep,
		});
	}
	// 2) 宿主上报的视觉模型
	const all = await vscode.lm.selectChatModels();
	for (const m of all) {
		if (!isHostVisionModel(m)) {
			continue;
		}
		const key = modelKey(m);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		options.push({ key, vendor: m.vendor, id: m.id, name: m.name, family: m.family });
	}
	return options;
}

/**
 * 创建一个"视觉模型获取器"：
 * - 若设置了 llm-bridge.visionModel，则用它（vendor/id 格式）
 * - 否则自动选择第一个可用的视觉模型（优先 llm-bridge 自己的多模态端点）
 * 设置变更后调用 reset() 会重新解析。
 *
 * 性能要点：
 * - 优先复用 llm-bridge 自己的多模态端点（直接走 OpenAI 客户端，无需 selectChatModels 枚举）。
 * - 结果（无论成功/失败）都会被缓存；"无可用视觉模型"的失败结果带有短 TTL。
 */
export function createVisionDescriberGetter(context: vscode.ExtensionContext): {
	get: () => Promise<VisionDescriber | undefined>;
	reset: () => void;
} {
	let describer: VisionDescriber | undefined;
	let promise: Promise<VisionDescriber | undefined> | undefined;
	let generation = 0;
	// 最近一次"缺少可用视觉模型"的时间戳；<=0 表示未处于不可用缓存期
	let unavailableSince = 0;

	return {
		async get(): Promise<VisionDescriber | undefined> {
			if (describer) {
				return describer;
			}
			// 短 TTL 内不要反复重跑模型枚举，直接返回"不可用"
			if (unavailableSince > 0 && Date.now() - unavailableSince < UNAVAILABLE_TTL_MS) {
				return undefined;
			}
			if (promise) {
				return promise;
			}
			const gen = generation;
			promise = (async () => {
				const options = await listVisionModelOptions(context);
				if (gen !== generation) {
					return undefined;
				}
				const configuredKey = getConfiguredVisionModelKey();
				// 零配置时自动选择第一个可用的视觉模型
				const picked = configuredKey
					? options.find((o) => o.key === configuredKey) ?? options[0]
					: options[0];
				if (!picked) {
					unavailableSince = Date.now();
					return undefined;
				}
				// llm-bridge 自己的多模态端点：直接走 OpenAI 客户端看图（无需 selectChatModels 二次查找）
				if (picked.bridge && picked.endpoint) {
					const ep = picked.endpoint;
					describer = {
						id: picked.key,
						describe: (request) => describeWithBridge(ep, request),
					};
					return describer;
				}
				// 宿主模型：从 selectChatModels 取对象后 sendRequest
				const all = await vscode.lm.selectChatModels();
				const model = all.find((m) => modelKey(m) === picked.key);
				if (!model) {
					unavailableSince = Date.now();
					return undefined;
				}
				describer = {
					id: picked.key,
					describe: (request) => describeWithModel(model, request),
				};
				return describer;
			})();
			try {
				const result = await promise;
				if (result) {
					unavailableSince = -1;
				}
				return result;
			} finally {
				promise = undefined;
			}
		},
		reset(): void {
			generation += 1;
			describer = undefined;
			promise = undefined;
			unavailableSince = -1;
		},
	};
}

/** 无可用视觉模型结果的最短缓存时长，避免每次发图都重新枚举模型。 */
const UNAVAILABLE_TTL_MS = 30_000;

export function getVisionPrompt(): string {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	return config.get<string>('visionPrompt', '').trim() || IMAGE_DESCRIPTION_PROMPT;
}

function getConfiguredVisionModelKey(): string | undefined {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	return config.get<string>('visionModel', '').trim() || undefined;
}

/** 宿主视觉模型判定：依赖运行时 capabilities.imageInput（尽力而为，可能不生效）。 */
function isHostVisionModel(model: vscode.LanguageModelChat): boolean {
	// capabilities 属运行时属性，稳定类型未收录，故防御性读取
	const capabilities = (model as unknown as { capabilities?: { imageInput?: boolean } }).capabilities;
	return (
		capabilities?.imageInput === true &&
		!EXCLUDED_VENDORS.has(model.vendor) &&
		!EXCLUDED_IDS.has(model.id)
	);
}

/** 用 llm-bridge 自己的多模态端点直接看图（走 OpenAI 客户端，最可靠）。 */
async function describeWithBridge(
	endpoint: CustomEndpoint,
	request: { prompt: string; images: VisionImage[]; token: vscode.CancellationToken }
): Promise<string> {
	const client = new OpenAIClient(endpoint.baseUrl, endpoint.apiKey);
	const content = [
		...request.images.map((img) => ({
			type: 'image_url' as const,
			image_url: { url: `data:${img.mimeType};base64,${Buffer.from(img.data).toString('base64')}` },
		})),
		{ type: 'text' as const, text: request.prompt },
	];
	let description = '';
	let error: Error | undefined;
	await client.streamChatCompletion(
		{
			model: endpoint.model,
			messages: [{ role: 'user', content }],
			stream: true,
		},
		{
			onContent: (text) => {
				description += text;
			},
			onError: (e) => {
				error = e;
			},
			onDone: () => {},
		},
		request.token
	);
	if (error) {
		throw error;
	}
	return description.trim();
}

async function describeWithModel(
	model: vscode.LanguageModelChat,
	request: { prompt: string; images: VisionImage[]; token: vscode.CancellationToken }
): Promise<string> {
	const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [
		...request.images.map((img) => new vscode.LanguageModelDataPart(img.data, img.mimeType)),
		new vscode.LanguageModelTextPart(request.prompt),
	];
	const msg = vscode.LanguageModelChatMessage.User(parts);
	const response = await model.sendRequest([msg], {}, request.token);
	let description = '';
	for await (const chunk of response.stream) {
		if (chunk instanceof vscode.LanguageModelTextPart) {
			description += chunk.value;
		}
	}
	return description.trim();
}

/**
 * 解析消息中的图片：
 * - 仅"当前（最后一条）用户消息"的图片会调用视觉代理生成文字描述；
 * - 历史消息里的图片被省略（只保留文字部分）；
 * - 若视觉代理不可用/失败，用占位文字代替并返回提示。
 */
export async function resolveImageMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	token: vscode.CancellationToken,
	getDescriber: () => Promise<VisionDescriber | undefined>
): Promise<{ messages: readonly vscode.LanguageModelChatRequestMessage[]; notice?: string }> {
	let hasImages = false;
	for (const m of messages) {
		if (m.content.some(isImageDataPart)) {
			hasImages = true;
			break;
		}
	}
	if (!hasImages) {
		return { messages };
	}

	const currentIndex = findCurrentImageMessageIndex(messages);
	const result: vscode.LanguageModelChatRequestMessage[] = [];
	let describer: VisionDescriber | undefined;
	let notice: string | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const imageParts = message.content.filter(isImageDataPart) as vscode.LanguageModelDataPart[];
		if (imageParts.length === 0) {
			result.push(message);
			continue;
		}
		const nonImageParts = message.content.filter((p) => !isImageDataPart(p)) as vscode.LanguageModelInputPart[];

		if (i === currentIndex) {
			if (!describer && !token.isCancellationRequested) {
				describer = await getDescriber();
			}
			let visionText = IMAGE_DESCRIPTION_UNAVAILABLE;
			if (describer && !token.isCancellationRequested) {
				try {
					const description = await describer.describe({
						prompt: getVisionPrompt(),
						images: imageParts.map(toVisionImage),
						token,
					});
					if (description.length > 0) {
						visionText = IMAGE_DESCRIPTION_PREFIX + description + IMAGE_DESCRIPTION_SUFFIX;
					}
				} catch (error) {
					notice = `[LLM Bridge] 视觉代理调用失败：${error instanceof Error ? error.message : String(error)}`;
				}
			} else if (!describer && !token.isCancellationRequested) {
				notice = '[LLM Bridge] 未找到可用的视觉模型：需要一个支持图片输入的模型来代看图片（可在设置 llm-bridge.visionModel 指定）';
			}
			result.push(createResolvedMessage(message, [...nonImageParts, new vscode.LanguageModelTextPart(visionText)]));
		} else {
			// 历史图片消息：省略图片，仅保留文字部分
			result.push(createResolvedMessage(message, nonImageParts));
		}
	}

	return { messages: result, notice };
}

function createResolvedMessage(
	message: vscode.LanguageModelChatRequestMessage,
	content: readonly vscode.LanguageModelInputPart[]
): vscode.LanguageModelChatRequestMessage {
	return { role: message.role, content, name: message.name };
}

export function isImageDataPart(part: unknown): part is vscode.LanguageModelDataPart {
	return (
		typeof vscode.LanguageModelDataPart === 'function' &&
		part instanceof vscode.LanguageModelDataPart &&
		part.mimeType.startsWith('image/')
	);
}

function toVisionImage(part: vscode.LanguageModelDataPart): VisionImage {
	return { mimeType: part.mimeType, data: part.data };
}

function findCurrentImageMessageIndex(messages: readonly vscode.LanguageModelChatRequestMessage[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			return undefined;
		}
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		if (message.content.some(isImageDataPart)) {
			return index;
		}
	}
	return undefined;
}
