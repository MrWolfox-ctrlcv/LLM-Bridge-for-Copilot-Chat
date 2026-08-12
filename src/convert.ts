import * as vscode from 'vscode';

export interface OpenAIContentPart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: { url: string };
}

export interface OpenAIMessage {
	role: string;
	content: string | OpenAIContentPart[];
	tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	reasoning_content?: string;
	tool_call_id?: string;
}

/**
 * 将 VS Code 聊天消息转换为 OpenAI 兼容格式。
 * @param imageInput 模型是否原生支持图片：true 时图片转 base64 数据 URL 直发；false 时图片忽略（已由视觉代理处理）。
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	imageInput: boolean
): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	for (const message of messages) {
		const role = mapRole(message.role);
		const contentParts: OpenAIContentPart[] = [];
		let contentText = '';
		let thinkingContent = '';
		const toolCalls: OpenAIMessage['tool_calls'] = [];
		const toolResults: { callId: string; content: string }[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (imageInput) {
					contentParts.push({ type: 'text', text: part.value });
				} else {
					contentText += part.value;
				}
			} else if (isImageDataPart(part)) {
				if (imageInput) {
					contentParts.push({ type: 'image_url', image_url: { url: imageToDataUrl(part) } });
				}
				// 纯文本模型：图片已由视觉代理解析为文字，此处忽略
			} else if (isThinkingPart(part)) {
				thinkingContent += normalizeThinkingText((part as { value: unknown }).value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: { name: part.name, arguments: safeStringify(part.input) },
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let toolContent = '';
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelTextPart) {
						toolContent += item.value;
					}
				}
				toolResults.push({ callId: part.callId, content: toolContent || safeStringify(part.content) });
			}
		}

		const content: string | OpenAIContentPart[] = imageInput ? contentParts : contentText;
		const hasContent = imageInput ? contentParts.length > 0 : contentText.length > 0;

		if (role === 'assistant') {
			if (hasContent || toolCalls.length > 0) {
				const msg: OpenAIMessage = { role: 'assistant', content };
				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}
				if (thinkingContent) {
					msg.reasoning_content = thinkingContent;
				}
				result.push(msg);
			}
		} else if (hasContent) {
			result.push({ role, content });
		}

		for (const tr of toolResults) {
			result.push({ role: 'tool', content: tr.content, tool_call_id: tr.callId });
		}
	}
	return result;
}

/** 将 VS Code 工具定义转换为 OpenAI tools 参数。 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined
): unknown[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		},
	}));
}

export function safeStringify(value: unknown): string {
	try {
		const s = JSON.stringify(value);
		return s === undefined ? '{}' : s;
	} catch {
		return '{}';
	}
}

/** 统计一条消息的字符数（兼容字符串与多模态数组）。 */
export function messageChars(msg: OpenAIMessage): number {
	let total = 0;
	if (typeof msg.content === 'string') {
		total += msg.content.length;
	} else {
		for (const part of msg.content) {
			total += part.text?.length ?? 0;
			total += part.image_url?.url.length ?? 0;
		}
	}
	total += msg.reasoning_content?.length ?? 0;
	if (msg.tool_calls) {
		for (const tc of msg.tool_calls) {
			total += tc.function?.name?.length ?? 0;
			total += tc.function?.arguments?.length ?? 0;
		}
	}
	return total;
}

export function countMessageChars(messages: OpenAIMessage[]): number {
	return messages.reduce((sum, msg) => sum + messageChars(msg), 0);
}

function mapRole(role: vscode.LanguageModelChatMessageRole): string {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'user';
	}
}

function isImageDataPart(part: unknown): part is vscode.LanguageModelDataPart {
	return (
		typeof vscode.LanguageModelDataPart === 'function' &&
		part instanceof vscode.LanguageModelDataPart &&
		part.mimeType.startsWith('image/')
	);
}

export function imageToDataUrl(part: vscode.LanguageModelDataPart): string {
	return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

function isThinkingPart(part: unknown): boolean {
	const ctor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
	return typeof ctor === 'function' && part instanceof (ctor as new (...args: never[]) => object);
}

function normalizeThinkingText(value: unknown): string {
	if (Array.isArray(value)) {
		return value.join('');
	}
	return typeof value === 'string' ? value : '';
}
