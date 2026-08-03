import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { OpenAIClient } from '../src/client';

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) {
				controller.enqueue(encoder.encode(c));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	});
}

describe('OpenAIClient.streamChatCompletion', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('流式输出 content 增量并触发 onDone，带 Bearer 头', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				'data: [DONE]\n\n',
			])
		);
		const client = new OpenAIClient('http://localhost/v1', 'sk-test');
		const content: string[] = [];
		let done = false;
		await client.streamChatCompletion(
			{ model: 'm', messages: [], stream: true },
			{
				onContent: (t) => content.push(t),
				onDone: () => {
					done = true;
				},
			}
		);
		expect(content.join('')).toBe('Hello');
		expect(done).toBe(true);
		expect(fetchMock.mock.calls[0][0]).toBe('http://localhost/v1/chat/completions');
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sk-test');
		// 请求体带 stream_options
		const body = JSON.parse(String(init.body));
		expect(body.stream_options).toEqual({ include_usage: true });
	});

	it('无 key 时不发送 Authorization 头', async () => {
		fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
		const client = new OpenAIClient('http://localhost/v1', '');
		await client.streamChatCompletion({ model: 'm', messages: [], stream: true }, {});
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it('tool_calls 跨 chunk 增量拼装，finish_reason=tool_calls 时触发 onToolCall', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"getWeather"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"beijing\\"}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				'data: [DONE]\n\n',
			])
		);
		const client = new OpenAIClient('http://localhost/v1', '');
		const calls: { id: string; name: string; args: string }[] = [];
		await client.streamChatCompletion(
			{ model: 'm', messages: [], stream: true },
			{
				onToolCall: (tc) =>
					calls.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments }),
			}
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ id: 'call_1', name: 'getWeather', args: '{"city":"beijing"}' });
	});

	it('思考内容与 usage 回调', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
				'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
				'data: [DONE]\n\n',
			])
		);
		const client = new OpenAIClient('http://localhost/v1', '');
		let thinking = '';
		let usage: Record<string, unknown> | undefined;
		await client.streamChatCompletion(
			{ model: 'm', messages: [], stream: true },
			{
				onThinking: (t) => {
					thinking += t;
				},
				onUsage: (u) => {
					usage = u;
				},
			}
		);
		expect(thinking).toBe('think ');
		expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
	});

	it('HTTP 错误触发 onError', async () => {
		fetchMock.mockResolvedValue(new Response('bad request', { status: 400 }));
		const client = new OpenAIClient('http://localhost/v1', '');
		let error: Error | undefined;
		await client.streamChatCompletion(
			{ model: 'm', messages: [], stream: true },
			{
				onError: (e) => {
					error = e;
				},
			}
		);
		expect(error).toBeDefined();
		expect(error?.message).toContain('400');
	});
});
