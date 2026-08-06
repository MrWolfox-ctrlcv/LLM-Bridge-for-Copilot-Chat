#!/usr/bin/env node
/**
 * 发布版打包脚本。
 *
 * 本地开发时 package.json 的 publisher 保持 `local`（本地扩展 local.llm-bridge 不受影响）；
 * 本脚本只在打包瞬间把 publisher 临时替换为正式发布者（默认 wolfox-labs，可用环境变量
 * LLM_BRIDGE_PUBLISHER 覆盖），生成 <publisher>.<name>-<version>.vsix 到 .vsix/ 目录，
 * 结束后立即恢复 package.json（try/finally 保证即使出错也不会留下半改状态）。
 *
 * 用法：
 *   npm run package:release                       # 用默认 publisher=wolfox-labs
 *   $env:LLM_BRIDGE_PUBLISHER="xxx"; npm run package:release   # 自定义 publisher
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const original = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(original);

const publisher = process.env.LLM_BRIDGE_PUBLISHER?.trim() || 'wolfox-labs';
const version = pkg.version;
const outFile = join(root, '.vsix', `${publisher}.${pkg.name}-${version}.vsix`);

try {
	pkg.publisher = publisher;
	writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
	// Windows 下 npx 是 npx.cmd，必须通过 shell 执行（.cmd 不能直接 spawn）
	const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
	execSync(`${npxCmd} vsce package -o "${outFile}"`, {
		cwd: root,
		stdio: 'inherit',
		shell: process.platform === 'win32',
	});
	console.log(`\n✅ 发布版已生成: ${outFile}`);
	console.log(`   扩展 ID: ${publisher}.${pkg.name} (v${version})`);
} finally {
	writeFileSync(pkgPath, original);
	console.log('✅ package.json 已恢复（publisher 保持 local，本地扩展不受影响）');
}
