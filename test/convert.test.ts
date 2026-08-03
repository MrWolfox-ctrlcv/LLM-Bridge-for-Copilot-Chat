import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => {
	class LanguageModelTextPart {
		value: string;
		constructor(value: string) {
			this.value = value;
		}
	}
	class LanguageModelDataPart {
		mimeType: string;
		data: Uint8Array;
		constructor(data: Uint8Array, mimeType: string) {
			this.data = data;
			this.mimeType = mimeType;
		}
	}
	class LanguageModelToolCallPart {
		callId: string;
		name: string;
		input: unknown;
		constructor(callId: string, name: string, input: unknown) {
			this.callId = callId;
			this.name = name;
			this.input = input;
		}
	}
	class LanguageModelToolResultPart {
		callId: string;
		content: unknown[];
		constructor(callId: string, content: unknown[]) {
			this.callId = callId;
			this.content = content;
		}
	}
	class LanguageModelThinkingPart {
		value: string;
		constructor(value: string) {
			this.value = value;
		}
	}
	const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
	return {
		LanguageModelTextPart,
		LanguageModelDataPart,
		LanguageModelToolCallPart,
		LanguageModelToolResultPart,
		LanguageModelThinkingPart,
		LanguageModelChatMessageRole,
	};
});

import {
	convertMessages,
	convertTools,
	safeStringify,
	messageChars,
	countMessageChars,
} from '../src/convert';

function msg(
	role: vscode.LanguageModelChatMessageRole,
	content: unknown[]
): vscode.LanguageModelChatRequestMessage {
	return { role, content: content as vscode.LanguageModelInputPart[] };
}

const User = vscode.LanguageModelChatMessageRole.User;
const Assistant = vscode.LanguageModelChatMessageRole.Assistant;

describe('convertMessages', () => {
	it('纯文本模型：user 文本消息转为字符串 content', () => {
		const result = convertMessages([msg(User, [new vscode.LanguageModelTextPart('hello')])], false);
		expect(result).toEqual([{ role: 'user', content: 'hello' }]);
	});

	it('多模态模型：文本转为 content 数组', () => {
		const result = convertMessages([msg(User, [new vscode.LanguageModelTextPart('hello')])], true);
		expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
	});

	it('纯文本模型：图片被忽略（已由视觉代理处理）', () => {
		const result = convertMessages(
			[
				msg(User, [
					new vscode.LanguageModelTextPart('看图'),
					new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
				]),
			],
			false
		);
		expect(result).toEqual([{ role: 'user', content: '看图' }]);
	});

	it('多模态模型：图片转为 base64 data URL 直发', () => {
		const result = convertMessages(
			[msg(User, [new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')])],
			true
		);
		const content = result[0].content as { type: string; image_url?: { url: string } }[];
		expect(content[0].type).toBe('image_url');
		expect(content[0].image_url?.url).toMatch(/^data:image\/png;base64,/);
	});

	it('工具调用：assistant 消息带 tool_calls', () => {
		const toolCall = new vscode.LanguageModelToolCallPart('call_1', 'getWeather', {
			city: 'beijing',
		});
		const result = convertMessages([msg(Assistant, [toolCall])], false);
		expect(result).toEqual([
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'getWeather', arguments: '{"city":"beijing"}' },
					},
				],
			},
		]);
	});

	it('工具结果：转为 role=tool 消息并带 tool_call_id', () => {
		const toolResult = new vscode.LanguageModelToolResultPart('call_1', [
			new vscode.LanguageModelTextPart('sunny'),
		]);
		const result = convertMessages([msg(User, [toolResult])], false);
		expect(result).toEqual([{ role: 'tool', content: 'sunny', tool_call_id: 'call_1' }]);
	});

	it('思考内容：assistant 消息带 reasoning_content', () => {
		const thinking = new vscode.LanguageModelThinkingPart('deep thoughts');
		const result = convertMessages(
			[msg(Assistant, [new vscode.LanguageModelTextPart('answer'), thinking])],
			false
		);
		expect(result).toEqual([
			{ role: 'assistant', content: 'answer', reasoning_content: 'deep thoughts' },
		]);
	});

	it('assistant 空消息（无内容无工具）被跳过', () => {
		const result = convertMessages([msg(Assistant, [])], false);
		expect(result).toEqual([]);
	});
});

describe('convertTools', () => {
	it('undefined / 空数组返回 undefined', () => {
		expect(convertTools(undefined)).toBeUndefined();
		expect(convertTools([])).toBeUndefined();
	});

	it('工具定义映射为 OpenAI tools 格式', () => {
		const tools = [
			{
				name: 'getWeather',
				description: '查天气',
				inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
			} as unknown as vscode.LanguageModelChatTool,
		];
		expect(convertTools(tools)).toEqual([
			{
				type: 'function',
				function: {
					name: 'getWeather',
					description: '查天气',
					parameters: { type: 'object', properties: { city: { type: 'string' } } },
				},
			},
		]);
	});
});

describe('safeStringify', () => {
	it('普通对象序列化', () => {
		expect(safeStringify({ a: 1 })).toBe('{"a":1}');
	});

	it('循环引用兜底为 {}', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(safeStringify(circular)).toBe('{}');
	});

	it('undefined 序列化兜底为 {}', () => {
		expect(safeStringify(undefined)).toBe('{}');
	});
});

describe('messageChars / countMessageChars', () => {
	it('字符串 content 按字符数统计', () => {
		expect(messageChars({ role: 'user', content: 'hello' })).toBe(5);
	});

	it('多模态 content 统计 text 与图片 URL', () => {
		const msgWithImage = {
			role: 'user',
			content: [
				{ type: 'text', text: 'ab' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } },
			],
		};
		expect(messageChars(msgWithImage)).toBe(2 + 'data:image/png;base64,xyz'.length);
	});

	it('tool_calls 与 reasoning_content 计入统计', () => {
		const m = {
			role: 'assistant',
			content: 'hi',
			reasoning_content: 'thinking',
			tool_calls: [
				{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{"a":1}' } },
			],
		};
		// content 2 + reasoning 8 + tool name 2 + tool arguments 7 = 19
		expect(messageChars(m)).toBe(19);
	});

	it('countMessageChars 累加所有消息', () => {
		const messages = [
			{ role: 'user', content: 'ab' },
			{ role: 'assistant', content: 'cdef' },
		];
		expect(countMessageChars(messages)).toBe(6);
	});
});
