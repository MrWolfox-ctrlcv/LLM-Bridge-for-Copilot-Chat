import * as vscode from 'vscode';

export interface ChatRequest {
	model: string;
	messages: unknown[];
	stream: boolean;
	tools?: unknown[];
	tool_choice?: string;
	max_tokens?: number;
	thinking?: { type: string };
	reasoning_effort?: string;
}

export interface ToolCallResult {
	id: string;
	function: { name: string; arguments: string };
}

export interface StreamCallbacks {
	onContent?: (text: string) => void;
	onThinking?: (text: string) => void;
	onToolCall?: (tc: ToolCallResult) => void;
	onUsage?: (usage: Record<string, unknown>) => void;
	onDone?: () => void;
	onError?: (error: Error) => void;
}

/** 轻量 OpenAI 兼容 SSE 流式客户端（无外部依赖，使用 Node 内置 fetch）。 */
export class OpenAIClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string
	) {}

	async streamChatCompletion(
		request: ChatRequest,
		callbacks: StreamCallbacks,
		token?: vscode.CancellationToken
	): Promise<void> {
		const controller = new AbortController();
		const cancelListener = token?.onCancellationRequested(() => controller.abort());
		if (token?.isCancellationRequested) {
			controller.abort();
		}
		try {
			const body = {
				...request,
				stream_options: { include_usage: true },
			};
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (this.apiKey) {
				headers.Authorization = `Bearer ${this.apiKey}`;
			}
			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
			}
			if (!response.body) {
				throw new Error('No response body received');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let latestUsage: Record<string, unknown> | undefined;
			const pendingToolCalls = new Map<number, ToolCallResult>();

			while (true) {
				if (token?.isCancellationRequested) {
					controller.abort();
					return;
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(':')) {
						continue;
					}
					if (trimmed === 'data: [DONE]') {
						flushToolCalls(pendingToolCalls, callbacks);
						if (latestUsage) {
							callbacks.onUsage?.(latestUsage);
						}
						callbacks.onDone?.();
						return;
					}
					if (!trimmed.startsWith('data: ')) {
						continue;
					}
					try {
						const chunk = JSON.parse(trimmed.slice(6)) as {
							usage?: Record<string, unknown>;
							choices?: Array<{
								delta?: {
									reasoning_content?: string;
									content?: string;
									tool_calls?: Array<{
										id?: string;
										index?: number;
										function?: { name?: string; arguments?: string };
									}>;
								};
								finish_reason?: string;
							}>;
						};
						if (chunk.usage) {
							latestUsage = chunk.usage;
						}
						const choice = chunk.choices?.[0];
						if (!choice) {
							continue;
						}
						const delta = choice.delta || {};
						if (delta.reasoning_content) {
							callbacks.onThinking?.(delta.reasoning_content);
						}
						if (delta.content) {
							callbacks.onContent?.(delta.content);
						}
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								const index = tc.index ?? 0;
								let pending = pendingToolCalls.get(index);
								if (!pending && tc.id) {
									pending = {
										id: tc.id,
										function: { name: '', arguments: '' },
									};
									pendingToolCalls.set(index, pending);
								}
								if (pending) {
									if (tc.function?.name) {
										pending.function.name += tc.function.name;
									}
									if (tc.function?.arguments) {
										pending.function.arguments += tc.function.arguments;
									}
								}
							}
						}
						if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
							flushToolCalls(pendingToolCalls, callbacks);
						}
					} catch {
						// 忽略无法解析的 SSE 行
					}
				}
			}
			if (latestUsage) {
				callbacks.onUsage?.(latestUsage);
			}
			callbacks.onDone?.();
		} catch (error) {
			if (isAbortError(error) && token?.isCancellationRequested) {
				return;
			}
			callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
		} finally {
			cancelListener?.dispose();
		}
	}

	/** 拉取 OpenAI 兼容的可用模型列表（GET {baseUrl}/models），失败时抛出错误。 */
	async listModels(): Promise<string[]> {
		const headers: Record<string, string> = {};
		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`;
		}
		const response = await fetch(`${this.baseUrl}/models`, {
			method: 'GET',
			headers,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
		const data = (await response.json()) as { data?: Array<{ id?: string }> };
		if (!Array.isArray(data?.data)) {
			throw new Error('响应缺少 data 模型数组');
		}
		return data.data
			.map((m) => m.id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0);
	}
}

function flushToolCalls(pending: Map<number, ToolCallResult>, callbacks: StreamCallbacks): void {
	for (const tc of pending.values()) {
		callbacks.onToolCall?.({ id: tc.id, function: tc.function });
	}
	pending.clear();
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
