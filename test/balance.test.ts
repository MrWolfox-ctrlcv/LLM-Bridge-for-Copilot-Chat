import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryBalance } from '../src/balance';
import type { ModelConfig } from '../src/config';

function model(partial: Partial<ModelConfig>): ModelConfig {
	return {
		id: 'm',
		name: 'M',
		baseUrl: 'https://api.example.com/v1',
		apiKey: 'sk-test',
		model: 'm',
		thinking: false,
		toolCalling: true,
		imageInput: false,
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
		contextWindow: 0,
		sendThinkingParam: false,
		...partial,
	};
}

describe('queryBalance', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('OpenRouter 端点走 /api/v1/credits 并格式化余额', async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ credits: { total: 100, used: 20, remaining: 80 } }), {
				status: 200,
			})
		);
		const text = await queryBalance(
			model({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key' })
		);
		expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/credits');
		expect(text).toContain('总额 $100');
		expect(text).toContain('已用 $20');
		expect(text).toContain('剩余 $80');
	});

	it('DeepSeek 风格端点走 /user/balance 并格式化余额', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					is_available: true,
					balance_infos: [
						{
							currency: 'CNY',
							total_balance: '88.88',
							granted_balance: '10',
							topped_up_balance: '78.88',
						},
					],
				}),
				{ status: 200 }
			)
		);
		const text = await queryBalance(model({ baseUrl: 'https://api.deepseek.com/v1' }));
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/user/balance');
		expect(text).toContain('CNY');
		expect(text).toContain('88.88');
		expect(text).toContain('赠送 10');
		expect(text).toContain('充值 78.88');
	});

	it('请求失败时抛出含状态码的错误', async () => {
		fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
		await expect(
			queryBalance(model({ baseUrl: 'https://api.deepseek.com/v1' }))
		).rejects.toThrow('401');
	});
});
