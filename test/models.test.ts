import { describe, expect, it } from 'vitest';
import { buildModels } from '../src/models';
import type { CustomEndpoint, ProviderSettings } from '../src/config';

function baseSettings(overrides?: Partial<ProviderSettings>): ProviderSettings {
	return {
		endpoints: [],
		contextWindow: 0,
		...overrides,
	};
}

function endpoint(partial: Partial<CustomEndpoint>): CustomEndpoint {
	return {
		id: 'ep1',
		name: '测试端点',
		baseUrl: 'http://localhost:8080/v1',
		apiKey: '',
		model: 'test-model',
		contextWindow: 0,
		toolCalling: true,
		imageInput: false,
		thinking: false,
		sendThinkingParam: false,
		...partial,
	};
}

describe('buildModels', () => {
	it('无任何配置时返回空数组', () => {
		expect(buildModels(baseSettings())).toEqual([]);
	});

	it('每个端点生成一个模型，id 带 custom- 前缀并保留思考/多模态设置', () => {
		const models = buildModels(
			baseSettings({
				endpoints: [
					endpoint({
						id: 'a',
						name: 'DeepSeek 官方 · V4 Pro',
						model: 'deepseek-v4-pro',
						thinking: true,
						sendThinkingParam: true,
					}),
					endpoint({
						id: 'b',
						name: 'OpenCode Zen · glm-5.2',
						baseUrl: 'https://opencode.ai/zen/v1',
						model: 'glm-5.2',
					}),
				],
			})
		);
		expect(models.map((m) => m.id)).toEqual(['custom-a', 'custom-b']);
		expect(models[0].model).toBe('deepseek-v4-pro');
		expect(models[0].thinking).toBe(true);
		expect(models[0].sendThinkingParam).toBe(true);
		expect(models[0].toolCalling).toBe(true);
		expect(models[1].thinking).toBe(false);
		expect(models[1].imageInput).toBe(false);
	});

	it('端点未设上下文时默认 128K', () => {
		const models = buildModels(baseSettings({ endpoints: [endpoint()] }));
		expect(models[0].maxInputTokens).toBe(131072);
	});

	it('端点支持上下文/工具/多模态/思考开关', () => {
		const models = buildModels(
			baseSettings({
				endpoints: [
					endpoint({
						id: 'b',
						name: 'B',
						model: 'mb',
						contextWindow: 8192,
						apiKey: 'k',
						imageInput: true,
						toolCalling: false,
						thinking: true,
					}),
				],
			})
		);
		expect(models).toHaveLength(1);
		const b = models[0];
		expect(b.maxInputTokens).toBe(8192);
		expect(b.apiKey).toBe('k');
		expect(b.imageInput).toBe(true);
		expect(b.toolCalling).toBe(false);
		expect(b.thinking).toBe(true);
	});

	it('无 key 的端点也能生成模型（本地端点场景）', () => {
		const models = buildModels(baseSettings({ endpoints: [endpoint({ apiKey: '' })] }));
		expect(models).toHaveLength(1);
		expect(models[0].apiKey).toBe('');
	});

	it('全局上下文覆盖所有模型', () => {
		const models = buildModels(
			baseSettings({
				endpoints: [endpoint(), endpoint({ id: 'x', model: 'mx' })],
				contextWindow: 9999,
			})
		);
		expect(models.every((m) => m.maxInputTokens === 9999)).toBe(true);
		expect(models.every((m) => m.contextWindow === 9999)).toBe(true);
	});
});
