import { describe, expect, it } from 'vitest';
import { buildModels } from '../src/models';
import type { CustomEndpoint, ProviderSettings } from '../src/config';

function baseSettings(overrides?: Partial<ProviderSettings>): ProviderSettings {
	return {
		deepseekApiKey: '',
		mimoApiKey: '',
		endpoints: [],
		deepseekContextWindow: 0,
		mimoContextWindow: 0,
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
		...partial,
	};
}

describe('buildModels', () => {
	it('无任何配置时返回空数组', () => {
		expect(buildModels(baseSettings())).toEqual([]);
	});

	it('DeepSeek key 存在时生成 Pro / Flash 两个模型', () => {
		const models = buildModels(baseSettings({ deepseekApiKey: 'sk-test' }));
		expect(models.map((m) => m.id)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
		expect(models[0].apiKey).toBe('sk-test');
		expect(models[0].toolCalling).toBe(true);
	});

	it('MiMo key 存在时生成 v2.5 Pro 与原生多模态 v2.5', () => {
		const models = buildModels(baseSettings({ mimoApiKey: 'tp-test' }));
		expect(models.map((m) => m.id)).toEqual(['mimo-v2.5-pro', 'mimo-v2.5']);
		const mimo25 = models.find((m) => m.id === 'mimo-v2.5');
		expect(mimo25?.imageInput).toBe(true);
	});

	it('endpoints 为每个自定义端点生成模型，id 带端点前缀', () => {
		const models = buildModels(
			baseSettings({
				endpoints: [
					endpoint({ id: 'a', name: 'A', model: 'ma' }),
					endpoint({
						id: 'b',
						name: 'B',
						model: 'mb',
						contextWindow: 8192,
						apiKey: 'k',
						imageInput: true,
						toolCalling: false,
					}),
				],
			})
		);
		expect(models).toHaveLength(2);
		const a = models[0];
		expect(a.id).toBe('custom-a');
		expect(a.name).toBe('A');
		expect(a.model).toBe('ma');
		expect(a.maxInputTokens).toBe(131072); // 默认 128K
		const b = models[1];
		expect(b.id).toBe('custom-b');
		expect(b.maxInputTokens).toBe(8192);
		expect(b.apiKey).toBe('k');
		expect(b.imageInput).toBe(true);
		expect(b.toolCalling).toBe(false);
	});

	it('无 key 的自定义端点也能生成模型（本地端点场景）', () => {
		const models = buildModels(baseSettings({ endpoints: [endpoint({ apiKey: '' })] }));
		expect(models).toHaveLength(1);
		expect(models[0].apiKey).toBe('');
	});

	it('全局上下文覆盖优先于供应商覆盖', () => {
		const models = buildModels(
			baseSettings({
				deepseekApiKey: 'sk-test',
				mimoApiKey: 'tp-test',
				deepseekContextWindow: 64000,
				mimoContextWindow: 32000,
				contextWindow: 9999,
			})
		);
		const ds = models.filter((m) => m.id.startsWith('deepseek-'));
		const mimo = models.filter((m) => m.id.startsWith('mimo-'));
		expect(ds.every((m) => m.maxInputTokens === 9999)).toBe(true);
		expect(mimo.every((m) => m.maxInputTokens === 9999)).toBe(true);
		expect(models.every((m) => m.contextWindow === 9999)).toBe(true);
	});
});
