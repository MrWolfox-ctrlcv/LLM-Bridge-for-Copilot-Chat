import { describe, expect, it, vi } from 'vitest';

// keys.ts 模块级不调用 vscode API，空 mock 即可安全导入
vi.mock('vscode', () => ({}));

import { parseKeyImportFile } from '../src/keys';

describe('parseKeyImportFile（API Key 备份文件解析）', () => {
	it('解析 {groupId: key} 并仅保留非空字符串条目', () => {
		expect(
			parseKeyImportFile(JSON.stringify({ g1: 'sk-a', g2: 'tp-b', g3: '', g4: 42, g5: null }))
		).toEqual({ g1: 'sk-a', g2: 'tp-b' });
	});

	it('key 两端空白被去除', () => {
		expect(parseKeyImportFile('{"g1": "  sk-c  "}')).toEqual({ g1: 'sk-c' });
	});

	it('非对象 JSON 返回空对象', () => {
		expect(parseKeyImportFile('[1,2]')).toEqual({});
		expect(parseKeyImportFile('"str"')).toEqual({});
		expect(parseKeyImportFile('null')).toEqual({});
	});

	it('非法 JSON 抛错（由调用方处理）', () => {
		expect(() => parseKeyImportFile('not json')).toThrow();
	});
});
