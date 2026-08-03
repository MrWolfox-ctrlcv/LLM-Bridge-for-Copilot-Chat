import * as vscode from 'vscode';

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

/** 不用于代看图片的供应商/模型。 */
const EXCLUDED_VENDORS = new Set(['llm-bridge', 'deepseek', 'claude-code', 'copilotcli']);
const EXCLUDED_IDS = new Set(['copilot-utility', 'copilot-utility-small']);

/** 自动模式下的首选视觉模型（找不到就取列表第一个）。 */
const DEFAULT_VISION_MODEL_ID = 'oswe-vscode-prime';

export interface VisionModelOption {
	/** 形如 vendor/id 的唯一键 */
	key: string;
	vendor: string;
	id: string;
	name: string;
	family: string;
}

/** 列出所有可用的视觉模型（支持图片输入，且不在排除名单）。 */
export async function listVisionModelOptions(): Promise<VisionModelOption[]> {
	const all = await vscode.lm.selectChatModels();
	return all
		.filter(isVisionModel)
		.map((m) => ({
			key: `${m.vendor}/${m.id}`,
			vendor: m.vendor,
			id: m.id,
			name: m.name,
			family: m.family,
		}));
}

/**
 * 创建一个"视觉模型获取器"：
 * - 若设置了 llm-bridge.visionModel，则用它（vendor/id 格式）
 * - 否则自动挑选：优先 oswe-vscode-prime，取不到就取列表第一个
 * 设置变更后调用 reset() 会重新解析。
 */
export function createVisionDescriberGetter(): {
	get: () => Promise<VisionDescriber | undefined>;
	reset: () => void;
} {
	let describer: VisionDescriber | undefined;
	let promise: Promise<VisionDescriber | undefined> | undefined;
	let generation = 0;

	return {
		async get(): Promise<VisionDescriber | undefined> {
			if (describer) {
				return describer;
			}
			if (promise) {
				return promise;
			}
			const gen = generation;
			promise = (async () => {
				const options = await listVisionModelOptions();
				if (gen !== generation) {
					return undefined;
				}
				const configuredKey = getConfiguredVisionModelKey();
				const picked = configuredKey
					? options.find((o) => o.key === configuredKey)
					: options.find((o) => o.id === DEFAULT_VISION_MODEL_ID) ?? options[0];
				if (!picked) {
					return undefined;
				}
				const all = await vscode.lm.selectChatModels();
				const model = all.find((m) => m.vendor === picked.vendor && m.id === picked.id);
				if (!model) {
					return undefined;
				}
				describer = {
					id: picked.key,
					describe: (request) => describeWithModel(model, request),
				};
				return describer;
			})();
			try {
				return await promise;
			} finally {
				promise = undefined;
			}
		},
		reset(): void {
			generation += 1;
			describer = undefined;
			promise = undefined;
		},
	};
}

export function getVisionPrompt(): string {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	return config.get<string>('visionPrompt', '').trim() || IMAGE_DESCRIPTION_PROMPT;
}

function getConfiguredVisionModelKey(): string | undefined {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	return config.get<string>('visionModel', '').trim() || undefined;
}

function isVisionModel(model: vscode.LanguageModelChat): boolean {
	// capabilities 属运行时属性，稳定类型未收录，故防御性读取
	const capabilities = (model as unknown as { capabilities?: { imageInput?: boolean } }).capabilities;
	return (
		capabilities?.imageInput === true &&
		!EXCLUDED_VENDORS.has(model.vendor) &&
		!EXCLUDED_IDS.has(model.id)
	);
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

function isImageDataPart(part: unknown): part is vscode.LanguageModelDataPart {
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
