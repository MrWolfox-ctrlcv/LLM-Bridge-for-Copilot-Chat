import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { trimMessagesToContext } from '../src/context';
import type { OpenAIMessage } from '../src/convert';

function msg(role: string, content: string): OpenAIMessage {
	return { role, content };
}

describe('trimMessagesToContext', () => {
	it('不超预算时原样返回（同一引用）', () => {
		const messages = [msg('user', 'hi')];
		const result = trimMessagesToContext(messages, 1000, 4);
		expect(result).toBe(messages);
	});

	it('超预算时丢弃最早消息，保留最近的并加说明', () => {
		// budget = floor(100 * 3 * 0.85) = 255
		const messages = [
			msg('user', 'A'.repeat(500)),
			msg('assistant', 'B'.repeat(500)),
			msg('user', 'C'.repeat(500)),
		];
		const result = trimMessagesToContext(messages, 100, 4);
		expect(result[0]).toEqual({ role: 'user', content: '[上下文超限，较早的消息已自动截断]' });
		expect(result).toHaveLength(2);
		expect(result[1].content).toContain('[...内容过长，已自动截断...]');
		// 保留的是最新一条用户消息（C）
		expect(result[1].content).toContain('C');
	});

	it('预算充足时保留全部消息', () => {
		// budget = floor(200 * 3 * 0.85) = 510，总 300 <= 510
		const messages = [
			msg('user', 'A'.repeat(100)),
			msg('assistant', 'B'.repeat(100)),
			msg('user', 'C'.repeat(100)),
		];
		const result = trimMessagesToContext(messages, 200, 4);
		expect(result).toHaveLength(3);
		expect(result).toBe(messages);
	});

	it('空数组返回空', () => {
		expect(trimMessagesToContext([], 1000, 4)).toEqual([]);
	});

	it('单条消息超预算时做尾部截断兜底', () => {
		// budget = floor(50 * 3 * 0.85) = 127
		const messages = [msg('user', 'x'.repeat(1000))];
		const result = trimMessagesToContext(messages, 50, 4);
		expect(result).toHaveLength(2);
		const last = result[1].content as string;
		expect(last.length).toBeLessThan(1000);
		expect(last).toContain('[...内容过长，已自动截断...]');
	});
});
