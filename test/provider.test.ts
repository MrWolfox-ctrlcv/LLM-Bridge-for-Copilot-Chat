import { describe, expect, it, test, vi } from 'vitest';

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
	return { LanguageModelTextPart, LanguageModelDataPart, LanguageModelToolCallPart, LanguageModelToolResultPart };
});

import * as vscode from 'vscode';

import { estimateMessageChars, reconcileReasoningContent, reportUsagePart } from '../src/provider';

interface ReportedPart {
	mimeType: string;
	data: Uint8Array;
}

function reportTo(parts: ReportedPart[]): { report: (part: unknown) => void } {
	return {
		report: (part) => parts.push(part as ReportedPart),
	};
}

describe('reportUsagePart（Copilot 会话信息面板的 token 用量上报）', () => {
	it('按 OpenAI 风格 usage 生成 mimeType=usage 的 data part', () => {
		const reported: ReportedPart[] = [];
		reportUsagePart(
			reportTo(reported) as never,
			{ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 10 } }
		);
		expect(reported).toHaveLength(1);
		expect(reported[0].mimeType).toBe('usage');
		expect(JSON.parse(new TextDecoder().decode(reported[0].data))).toEqual({
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
			prompt_tokens_details: { cached_tokens: 10 },
		});
	});

	it('兼容 DeepSeek 风格 prompt_cache_hit_tokens，缺 total_tokens 时回退为 prompt+completion', () => {
		const reported: ReportedPart[] = [];
		reportUsagePart(reportTo(reported) as never, { prompt_tokens: 30, completion_tokens: 7, prompt_cache_hit_tokens: 3 });
		expect(JSON.parse(new TextDecoder().decode(reported[0].data))).toEqual({
			prompt_tokens: 30,
			completion_tokens: 7,
			total_tokens: 37,
			prompt_tokens_details: { cached_tokens: 3 },
		});
	});

	it('无 usage 或缺少 token 字段时不发送任何 part', () => {
		const reported: ReportedPart[] = [];
		const progress = reportTo(reported);
		reportUsagePart(progress as never, undefined);
		reportUsagePart(progress as never, { foo: 'bar' });
		expect(reported).toHaveLength(0);
	});

	it('负数/非法数值钳制为 0', () => {
		const reported: ReportedPart[] = [];
		reportUsagePart(reportTo(reported) as never, { prompt_tokens: -1, completion_tokens: 0, total_tokens: -1 });
		const parsed = JSON.parse(new TextDecoder().decode(reported[0].data)) as Record<string, unknown>;
		expect(parsed.prompt_tokens).toBe(0);
		expect(parsed.total_tokens).toBe(0);
	});
});

describe('reconcileReasoningContent（思考模式 reasoning_content 协议校正）', () => {
	it('enabled：缺失字段的 assistant 消息补空串，已有/非 assistant 不动', () => {
		const result = reconcileReasoningContent(
			[
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: '答案A' },
				{ role: 'assistant', content: '答案B', reasoning_content: '思考B' },
			],
			'enabled'
		);
		expect(result[0]).toEqual({ role: 'user', content: 'hi' });
		expect(result[1]).toEqual({ role: 'assistant', content: '答案A', reasoning_content: '' });
		expect(result[2]).toEqual({ role: 'assistant', content: '答案B', reasoning_content: '思考B' });
	});

	it('disabled：移除 assistant 消息上的 reasoning_content', () => {
		const result = reconcileReasoningContent(
			[
				{ role: 'assistant', content: '答案', reasoning_content: '思考' },
				{ role: 'assistant', content: '答案2' },
			],
			'disabled'
		);
		expect(result[0]).toEqual({ role: 'assistant', content: '答案' });
		expect(result[1]).toEqual({ role: 'assistant', content: '答案2' });
	});

	it('passthrough：字段原样保留', () => {
		const input = [
			{ role: 'assistant', content: '答案', reasoning_content: '思考' },
			{ role: 'assistant', content: '答案2' },
		];
		expect(reconcileReasoningContent(input, 'passthrough')).toEqual(input);
	});
});

describe('estimateMessageChars（provideTokenCount 估算）', () => {
	test('纯字符串直接返回长度', () => {
		expect(estimateMessageChars('hello 世界')).toBe(8);
	});

	test('文本 part 累加 value 长度', () => {
		const chars = estimateMessageChars({
			role: 1,
			content: [new vscode.LanguageModelTextPart('abc')],
		} as never);
		expect(chars).toBe(3);
	});

	test('图片 part 用固定估算值而非 base64 字节数', () => {
		const bigImage = new Uint8Array(1024 * 1024); // 1MB 假图
		const chars = estimateMessageChars({
			role: 1,
			content: [new vscode.LanguageModelDataPart(bigImage, 'image/png')],
		} as never);
		expect(chars).toBe(1000); // IMAGE_PART_ESTIMATED_CHARS，而非 1M
	});

	test('非图片二进制附件（如 PDF）按字节数但设上限', () => {
		const huge = new Uint8Array(1024 * 1024);
		const chars = estimateMessageChars({
			role: 1,
			content: [new vscode.LanguageModelDataPart(huge, 'application/pdf')],
		} as never);
		expect(chars).toBe(10000); // MAX_BINARY_PART_CHARS
	});

	test('工具调用 part 计入名称与参数', () => {
		const chars = estimateMessageChars({
			role: 2,
			content: [new vscode.LanguageModelToolCallPart('call-1', 'bash', { command: 'ls' })],
		} as never);
		expect(chars).toBeGreaterThan(4);
	});
});
