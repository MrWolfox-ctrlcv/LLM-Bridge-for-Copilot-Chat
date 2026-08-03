import * as vscode from 'vscode';
import { getProviderSettings } from './config';
import { buildModels } from './models';
import { isDeepSeekEndpoint, queryDeepSeekBalance } from './balance';
import { LlmBridgeProvider } from './provider';
import { listVisionModelOptions } from './vision';
import { SECRET_KEYS, endpointSecretKey, migrateLegacyKeys } from './keys';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new LlmBridgeProvider(context);

	// 一次性迁移：把 settings.json 中的旧 key 迁入系统钥匙串（SecretStorage）
	void migrateLegacyKeys(context);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('llm-bridge', provider),
		vscode.commands.registerCommand('llm-bridge.refreshModels', () => provider.refreshModelPicker()),
		vscode.commands.registerCommand('llm-bridge.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.llm-bridge');
		}),
		vscode.commands.registerCommand('llm-bridge.addModel', async () => {
			const config = vscode.workspace.getConfiguration('llm-bridge');
			type PresetKind = 'deepseek' | 'mimo' | 'openai';
			interface PresetItem extends vscode.QuickPickItem {
				preset: PresetKind;
			}
			const presets: PresetItem[] = [
				{
					label: 'DeepSeek 官方（V4 Pro + Flash）',
					description: '预设 · 官网参数',
					detail: 'baseUrl: https://api.deepseek.com · 模型: deepseek-v4-pro / deepseek-v4-flash · 1M 上下文 · 思考',
					preset: 'deepseek',
				},
				{
					label: 'MiMo 官方（v2.5 Pro + v2.5 多模态）',
					description: '预设 · 官网参数',
					detail: 'baseUrl: https://token-plan-cn.xiaomimimo.com/v1 · 模型: mimo-v2.5-pro / mimo-v2.5 · 1M 上下文',
					preset: 'mimo',
				},
				{
					label: '自定义 OpenAI 兼容端点',
					description: '通用',
					detail: '任意 baseUrl + apiKey + model（本地模型如 llama.cpp 也用它）',
					preset: 'openai',
				},
			];
			const picked = await vscode.window.showQuickPick(presets, {
				title: 'LLM Bridge: 添加模型（预设）',
				placeHolder: '选择预设，填入 key 后模型自动出现在 Copilot Chat 选择器',
			});
			if (!picked) {
				return;
			}

			if (picked.preset === 'deepseek') {
				const existing = config.get<string>('deepseekApiKey', '');
				if (existing) {
					void vscode.window.showInformationMessage(
						'[LLM Bridge] DeepSeek 已配置（llm-bridge.deepseekApiKey 已填写），模型已在选择器中。如需更换请改该设置。'
					);
					return;
				}
				const key = await vscode.window.showInputBox({
					title: 'DeepSeek API Key（platform.deepseek.com 申请）',
					password: true,
					placeHolder: 'sk-...',
					ignoreFocusOut: true,
				});
				if (key === undefined) {
					return;
				}
				await context.secrets.store(SECRET_KEYS.deepseek, key.trim());
				provider.refreshModelPicker();
				void vscode.window.showInformationMessage(
					'[LLM Bridge] DeepSeek 已添加 ✓（Key 已安全存入系统钥匙串）模型选择器 → LLM Bridge → DeepSeek V4 Pro / Flash'
				);
			} else if (picked.preset === 'mimo') {
				const existing = config.get<string>('mimoApiKey', '');
				if (existing) {
					void vscode.window.showInformationMessage(
						'[LLM Bridge] MiMo 已配置（llm-bridge.mimoApiKey 已填写），模型已在选择器中。如需更换请改该设置。'
					);
					return;
				}
				const token = await vscode.window.showInputBox({
					title: 'MiMo Token / Token Plan（platform.xiaomimimo.com）',
					password: true,
					placeHolder: 'tp-...',
					ignoreFocusOut: true,
				});
				if (token === undefined) {
					return;
				}
				await context.secrets.store(SECRET_KEYS.mimo, token.trim());
				provider.refreshModelPicker();
				void vscode.window.showInformationMessage(
					'[LLM Bridge] MiMo 已添加 ✓（Key 已安全存入系统钥匙串）模型选择器 → LLM Bridge → MiMo v2.5 / v2.5 Pro'
				);
			} else {
				const baseUrl = await vscode.window.showInputBox({
					title: '自定义 OpenAI 兼容端点 baseUrl',
					placeHolder: '如 https://api.example.com/v1 或 http://127.0.0.1:8080/v1',
					ignoreFocusOut: true,
				});
				if (baseUrl === undefined) {
					return;
				}
				const model = await vscode.window.showInputBox({
					title: '模型 ID',
					placeHolder: '如 gpt-4o、gemma4',
					ignoreFocusOut: true,
				});
				if (model === undefined) {
					return;
				}
				const apiKey = await vscode.window.showInputBox({
					title: 'API Key（本地端点可留空；云端 Key 将安全存入系统钥匙串）',
					password: true,
					ignoreFocusOut: true,
				});
				if (apiKey === undefined) {
					return;
				}
				const nameInput = await vscode.window.showInputBox({
					title: '显示名称（可留空，默认用模型 ID）',
					placeHolder: model.trim(),
					ignoreFocusOut: true,
				});
				if (nameInput === undefined) {
					return;
				}
				const name = nameInput.trim() || model.trim();
				const id = `custom-${Date.now().toString(36)}`;
				const current = config.get<unknown[]>('endpoints', []);
				await config.update(
					'endpoints',
					[
						...current,
						{
							id,
							name,
							baseUrl: baseUrl.trim().replace(/\/+$/, ''),
							model: model.trim(),
							contextWindow: 0,
							toolCalling: true,
							imageInput: false,
						},
					],
					vscode.ConfigurationTarget.Global
				);
				if (apiKey.trim()) {
					await context.secrets.store(endpointSecretKey(id), apiKey.trim());
				}
				provider.refreshModelPicker();
				void vscode.window.showInformationMessage(
					`[LLM Bridge] 自定义端点「${name}」已添加 ✓ 模型选择器 → LLM Bridge → ${name}`
				);
			}
		}),
		vscode.commands.registerCommand('llm-bridge.checkBalance', async () => {
			const deepseekModels = buildModels(await getProviderSettings(context)).filter(isDeepSeekEndpoint);
			if (deepseekModels.length === 0) {
				void vscode.window.showInformationMessage('[LLM Bridge] 未配置 DeepSeek（llm-bridge.deepseekApiKey 为空），无法查询余额。');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				deepseekModels.map((m) => ({ label: m.name, description: m.baseUrl, model: m })),
				{ placeHolder: '选择要查询余额的 DeepSeek 账户' }
			);
			if (!picked) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '[LLM Bridge] 查询余额中...' },
				async () => {
					try {
						const text = await queryDeepSeekBalance(picked.model);
						void vscode.window.showInformationMessage(`[LLM Bridge] ${picked.model.name} 余额：\n${text}`);
					} catch (error) {
						void vscode.window.showErrorMessage(
							`[LLM Bridge] 余额查询失败：${error instanceof Error ? error.message : String(error)}`
						);
					}
				}
			);
		}),
		vscode.commands.registerCommand('llm-bridge.setVisionModel', async () => {
			const options = await listVisionModelOptions();
			if (options.length === 0) {
				void vscode.window.showWarningMessage('[LLM Bridge] 当前没有可用的视觉模型（需要支持图片输入的模型）。');
				return;
			}
			const config = vscode.workspace.getConfiguration('llm-bridge');
			const current = config.get<string>('visionModel', '');
			const picked = await vscode.window.showQuickPick(
				options.map((o) => ({
					label: o.name && o.name !== o.id ? `${o.name} (${o.id})` : o.id,
					description: o.vendor,
					detail: o.key,
					picked: o.key === current,
				})),
				{
					placeHolder: '选择视觉代理模型（Esc 取消，不修改）',
					title: 'LLM Bridge: 配置视觉代理模型（仅纯文本模型看图用）',
				}
			);
			if (!picked) {
				return;
			}
			await config.update('visionModel', picked.detail, vscode.ConfigurationTarget.Global);
			provider.resetVision();
			void vscode.window.showInformationMessage(`[LLM Bridge] 视觉代理模型已设为: ${picked.detail}`);
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('llm-bridge')) {
				provider.refreshModelPicker();
				provider.resetVision();
			}
		})
	);
}

export function deactivate(): void {
	// 无需清理
}
