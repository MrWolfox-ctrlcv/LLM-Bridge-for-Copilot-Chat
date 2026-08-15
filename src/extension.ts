import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { getProviderSettings, type CustomEndpoint, type ModelCost } from './config';
import { buildModels } from './models';
import { queryBalance } from './balance';
import { LlmBridgeProvider } from './provider';
import { listVisionModelOptions } from './vision';
import { SECRET_KEYS, endpointSecretKey, invalidateApiKeyCache, migrateLegacyKeys, parseKeyImportFile, readApiKey } from './keys';
import { OpenAIClient } from './client';
import { SettingsPanel } from './settingsPanel';

/** LLM Bridge 诊断输出面板（排查问题用，可在「输出」面板查看）。 */
const output = vscode.window.createOutputChannel('LLM Bridge');

/** 当前激活的 provider 引用，供 deactivate 时清理模型选择器。 */
let activeProvider: LlmBridgeProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const provider = new LlmBridgeProvider(context);
	activeProvider = provider;

	// 一次性迁移：旧 key 迁入系统钥匙串 + 旧内置 DeepSeek/MiMo 配置转为统一端点
	void migrateLegacyKeys(context);
	void migrateLegacyProviders(context);

	context.subscriptions.push(
		output,
		vscode.lm.registerLanguageModelChatProvider('llm-bridge', provider),
		vscode.commands.registerCommand('llm-bridge.refreshModels', () => provider.refreshModelPicker()),
		vscode.commands.registerCommand('llm-bridge.testConnection', async () => {
			const settings = await getProviderSettings(context);
			if (settings.endpoints.length === 0) {
				void vscode.window.showInformationMessage('[LLM Bridge] 当前没有已配置的端点，请先添加模型。');
				return;
			}
			// 按 baseUrl 分组（同一供应商共享 Key 的一组模型）
			const groups = new Map<string, CustomEndpoint[]>();
			for (const ep of settings.endpoints) {
				groups.set(ep.baseUrl, [...(groups.get(ep.baseUrl) ?? []), ep]);
			}
			const items = [...groups.entries()].map(([baseUrl, eps]) => ({
				label: eps[0].name.replace(/ · .*/, ''),
				description: `${eps.length} 个模型`,
				detail: `${baseUrl} · ${eps.map((e) => e.model).join('、')}`,
				baseUrl,
			}));
			const picked = await vscode.window.showQuickPick(items, {
				title: 'LLM Bridge: 测试连通性',
				placeHolder: '选择要测试的端点',
			});
			if (!picked) {
				return;
			}
			const ep = settings.endpoints.find((e) => e.baseUrl === picked.baseUrl);
			if (!ep) {
				return;
			}
			const client = new OpenAIClient(ep.baseUrl, ep.apiKey);
			try {
				const models = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `[LLM Bridge] 正在测试 ${ep.name}...`,
					},
					() => client.listModels()
				);
				void vscode.window.showInformationMessage(
					`[LLM Bridge] ${ep.name} 连通正常 ✓（${models.length} 个可用模型）`
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`[LLM Bridge] ${ep.name} 连通失败：${msg}`);
			}
		}),
		vscode.commands.registerCommand('llm-bridge.openSettingsPanel', () => SettingsPanel.createOrShow(context)),
		// 旧命令 id 保留为打开面板的别名（向后兼容 keybinding 等引用）
		vscode.commands.registerCommand('llm-bridge.openSettings', () => SettingsPanel.createOrShow(context)),
		// 打开原生 VS Code 设置页（@ext:llm-bridge 过滤），供高级用户直接编辑 JSON；不进命令面板
		vscode.commands.registerCommand('llm-bridge.openNativeSettings', () => {
			const bridgeExt = vscode.extensions.all.find((e) => e.packageJSON?.name === 'llm-bridge');
			const id = bridgeExt?.id ?? 'wolfox-labs.llm-bridge';
			void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${id}`);
		}),
		vscode.commands.registerCommand('llm-bridge.addModel', async () => {
			const config = vscode.workspace.getConfiguration('llm-bridge');
			type PresetKind =
				| 'deepseek'
				| 'mimo'
				| 'mimo-official'
				| 'opencode-zen'
				| 'opencode-go'
				| 'openrouter'
				| 'openai';
			interface PresetItem extends vscode.QuickPickItem {
				preset: PresetKind;
			}
			const presets: PresetItem[] = [
				{
					label: 'DeepSeek 官方（V4 Pro + Flash）',
					description: '预设 · 按量付费',
					detail: 'baseUrl: https://api.deepseek.com/v1 · 官方模型 · 思考模式',
					preset: 'deepseek',
				},
				{
					label: 'MiMo Token Plan（v2.5 Pro + v2.5 多模态）',
					description: '预设 · 订阅套餐',
					detail: 'baseUrl: https://token-plan-cn.xiaomimimo.com/v1',
					preset: 'mimo',
				},
				{
					label: 'MiMo 官方 API（v2.5 按量付费）',
					description: '预设 · 官网按量',
					detail: 'baseUrl: https://api.xiaomimimo.com/v1',
					preset: 'mimo-official',
				},
				{
					label: 'OpenCode Zen（按量付费）',
					description: '预设 · opencode.ai',
					detail: 'baseUrl: https://opencode.ai/zen/v1',
					preset: 'opencode-zen',
				},
				{
					label: 'OpenCode Go（订阅制 $10/月）',
					description: '预设 · opencode.ai',
					detail: 'baseUrl: https://opencode.ai/zen/go/v1',
					preset: 'opencode-go',
				},
				{
					label: 'OpenRouter（按量付费）',
					description: '预设 · openrouter.ai',
					detail: 'baseUrl: https://openrouter.ai/api/v1 · 支持余额查询',
					preset: 'openrouter',
				},
				{
					label: '自定义 OpenAI 兼容端点',
					description: '通用',
					detail: '任意 baseUrl + Key（本地模型如 llama.cpp 也用它）',
					preset: 'openai',
				},
			];
			const picked = await vscode.window.showQuickPick(presets, {
				title: 'LLM Bridge: 添加模型',
				placeHolder: '选择预设（所有预设流程一致：填 Key → 勾选可用模型）',
			});
			if (!picked) {
				return;
			}

			// 所有预设统一走同一流程：预填 baseUrl → 填 Key → 拉取并勾选模型列表
			const endpointPresets: Record<
				string,
				{
					baseUrl: string;
					name: string;
					thinking?: boolean;
					sendThinkingParam?: boolean;
					/** 该预设的官方价格（按模型 ID 查表；查不到则不设置）。 */
					cost?: (model: string) => ModelCost | undefined;
				}
			> = {
				deepseek: {
					baseUrl: 'https://api.deepseek.com/v1',
					name: 'DeepSeek 官方',
					thinking: true,
					sendThinkingParam: true,
					cost: deepseekCost,
				},
				mimo: { baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', name: 'MiMo Token Plan', thinking: true, sendThinkingParam: false },
				'mimo-official': { baseUrl: 'https://api.xiaomimimo.com/v1', name: 'MiMo 官方 API', thinking: true, sendThinkingParam: false },
				'opencode-zen': { baseUrl: 'https://opencode.ai/zen/v1', name: 'OpenCode Zen' },
				'opencode-go': { baseUrl: 'https://opencode.ai/zen/go/v1', name: 'OpenCode Go' },
				openrouter: { baseUrl: 'https://openrouter.ai/api/v1', name: 'OpenRouter' },
			};
			await addCustomEndpoint(context, provider, config, endpointPresets[picked.preset]);
		}),
		vscode.commands.registerCommand('llm-bridge.manageModels', async () => {
			const settings = await getProviderSettings(context);
			const config = vscode.workspace.getConfiguration('llm-bridge');
			if (settings.endpoints.length === 0) {
				void vscode.window.showInformationMessage('[LLM Bridge] 当前没有已配置的模型。');
				return;
			}

			// 按 baseUrl 分组（同一供应商共享 Key 的一组模型）
			const groups = new Map<string, CustomEndpoint[]>();
			for (const ep of settings.endpoints) {
				groups.set(ep.baseUrl, [...(groups.get(ep.baseUrl) ?? []), ep]);
			}
			const groupItems = [...groups.entries()].map(([baseUrl, eps]) => ({
				label: eps[0].name.replace(/ · .*/, ''),
				description: `${eps.length} 个模型`,
				detail: `${baseUrl} · ${eps.map((e) => e.model).join('、')}`,
				baseUrl,
			}));
			const pickedGroup = await vscode.window.showQuickPick(groupItems, {
				title: 'LLM Bridge: 管理模型（选择一个供应商分组）',
				placeHolder: '刷新模型列表 / 删除模型（Esc 取消）',
			});
			if (!pickedGroup) {
				return;
			}
			const groupEps = groups.get(pickedGroup.baseUrl) ?? [];

			const action = await vscode.window.showQuickPick(
				[
					{ label: '刷新模型列表', description: '重新拉取 /models，勾选要保留/新增的模型', value: 'refresh' },
					{ label: '删除单个模型', description: '从该分组删除某个模型', value: 'delete-one' },
					{ label: '删除整个分组', description: `删除 ${groupEps.length} 个模型及共享 Key`, value: 'delete-group' },
				],
				{ title: `操作：${pickedGroup.label}`, placeHolder: '选择操作' }
			);
			if (!action) {
				return;
			}

			const removeByIds = async (ids: Set<string>): Promise<void> => {
				const current = config.get<unknown[]>('endpoints', []);
				await config.update(
					'endpoints',
					current.filter((raw) => !ids.has(String((raw as { id?: unknown }).id ?? ''))),
					vscode.ConfigurationTarget.Global
				);
			};

			if (action.value === 'delete-group') {
				const confirmed = await vscode.window.showWarningMessage(
					`[LLM Bridge] 确定删除分组「${pickedGroup.label}」下的 ${groupEps.length} 个模型？`,
					{ modal: true },
					'删除'
				);
				if (confirmed !== '删除') {
					return;
				}
				for (const ep of groupEps) {
					await context.secrets.delete(endpointSecretKey(ep.group || ep.id));
				}
				await removeByIds(new Set(groupEps.map((e) => e.id)));
				provider.refreshModelPicker();
				void vscode.window.showInformationMessage(`[LLM Bridge] 已删除分组「${pickedGroup.label}」✓`);
				return;
			}

			if (action.value === 'delete-one') {
				const picked = await vscode.window.showQuickPick(
					groupEps.map((ep) => ({ label: ep.name, description: ep.model, detail: ep.baseUrl, ep })),
					{ title: '选择要删除的模型', placeHolder: '删除单个模型（共享 Key 保留，若删空则一并清理）' }
				);
				if (!picked) {
					return;
				}
				const confirmed = await vscode.window.showWarningMessage(
					`[LLM Bridge] 确定删除「${picked.ep.name}」？`,
					{ modal: true },
					'删除'
				);
				if (confirmed !== '删除') {
					return;
				}
				await removeByIds(new Set([picked.ep.id]));
				if (groupEps.length <= 1) {
					await context.secrets.delete(endpointSecretKey(picked.ep.group || picked.ep.id));
				}
				provider.refreshModelPicker();
				void vscode.window.showInformationMessage(`[LLM Bridge] 已删除「${picked.ep.name}」✓`);
				return;
			}

			// 刷新模型列表：重新拉取 /models，勾选最新集合后整体更新该分组
			const groupId = groupEps[0].group || groupEps[0].id;
			const apiKey =
				groupEps[0].apiKey || (await context.secrets.get(endpointSecretKey(groupId))) || '';
			const fetched = await fetchModelList(pickedGroup.baseUrl, apiKey);
			if (fetched.length === 0) {
				void vscode.window.showWarningMessage(
					'[LLM Bridge] 无法获取该端点的模型列表（或列表为空），未做更改。'
				);
				return;
			}
			const currentModels = new Set(groupEps.map((e) => e.model));
			const pickedModels = await vscode.window.showQuickPick(
				fetched.map((id) => ({ label: id, description: '可选模型', picked: currentModels.has(id) })),
				{
					title: `勾选 ${pickedGroup.label} 要使用的模型`,
					placeHolder: `当前已用 ${currentModels.size} 个，可勾选新增或取消移除（供应商更新后刷新即可看到新模型）`,
					canPickMany: true,
					ignoreFocusOut: true,
				}
			);
			if (!pickedModels) {
				return;
			}
			const selected = new Set(pickedModels.map((p) => p.label));
			const toAdd = fetched.filter((id) => selected.has(id) && !currentModels.has(id));
			const toRemove = groupEps.filter((e) => !selected.has(e.model));
			const current = config.get<unknown[]>('endpoints', []);
			let next = current.filter((raw) => {
				const rawId = String((raw as { id?: unknown }).id ?? '');
				return !toRemove.some((e) => e.id === rawId);
			});
			// 供应商前缀：仅当现有显示名带「 · 」分隔（如「OpenCode Zen · model」）时提取；
			// 若显示名是裸模型 ID 则不拼接，新增模型直接以模型 ID 作为显示名，
			// 避免出现「deepseek-v4-flash-free · longcat-2.0-free」两个模型名拼在一起。
			const sep = ' · ';
			const first = groupEps[0];
			const baseName = first.name.includes(sep) ? first.name.split(sep)[0] : '';
			const stamp = Date.now().toString(36);
			let idx = 0;
			for (const id of toAdd) {
				const epId = `${groupId}-${stamp}-${idx++}`;
				next = [
					...next,
					{
						id: epId,
						name: baseName ? `${baseName}${sep}${id}` : id,
						baseUrl: pickedGroup.baseUrl,
						model: id,
						contextWindow: groupEps[0].contextWindow,
						toolCalling: true,
						imageInput: false,
						thinking: groupEps[0].thinking,
						sendThinkingParam: groupEps[0].sendThinkingParam,
						group: groupId,
						...(groupEps[0].cost ? { cost: groupEps[0].cost } : {}),
					},
				];
			}
			await config.update('endpoints', next, vscode.ConfigurationTarget.Global);
			provider.refreshModelPicker();
			void vscode.window.showInformationMessage(
				`[LLM Bridge] 已更新「${pickedGroup.label}」：新增 ${toAdd.length} 个，移除 ${toRemove.length} 个 ✓`
			);
		}),
		vscode.commands.registerCommand('llm-bridge.checkBalance', async () => {
			const allModels = buildModels(await getProviderSettings(context));
			if (allModels.length === 0) {
				void vscode.window.showInformationMessage('[LLM Bridge] 未配置任何模型，无法查询余额。');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				allModels.map((m) => ({ label: m.name, description: m.baseUrl, model: m })),
				{ placeHolder: '选择要查询余额的账户（DeepSeek 风格 /user/balance、OpenRouter /credits）' }
			);
			if (!picked) {
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '[LLM Bridge] 查询余额中...' },
				async () => {
					try {
						const text = await queryBalance(picked.model);
						void vscode.window.showInformationMessage(`[LLM Bridge] ${picked.model.name} 余额：\n${text}`);
					} catch (error) {
						void vscode.window.showErrorMessage(
							`[LLM Bridge] 余额查询失败（该端点可能不支持余额查询）：${error instanceof Error ? error.message : String(error)}`
						);
					}
				}
			);
		}),
		vscode.commands.registerCommand('llm-bridge.setVisionModel', async () => {
			const options = await listVisionModelOptions(context);
			if (options.length === 0) {
				void vscode.window.showWarningMessage(
					'[LLM Bridge] 当前没有可用的视觉模型。请先配置一个支持图片输入的模型（如 MiMo v2.5，端点勾选 imageInput），或确认已安装支持视觉的模型。'
				);
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
		vscode.commands.registerCommand('llm-bridge.importApiKeys', async () => {
			// 从本地备份文件恢复 API Key 到系统钥匙串（SecretStorage）。
			// 备份文件格式：{ groupId: apiKey }（groupId 为端点 group 或端点 id）。
			// 用途：扩展署名/ID 迁移后（如 local → wolfox-labs）SecretStorage 不随扩展迁移，
			// 用此命令从备份 JSON 一次性恢复，避免手动重新输入。
			const defaultUri = vscode.Uri.file(path.join(os.homedir(), 'llm-bridge-import-keys.json'));
			const picked = await vscode.window.showOpenDialog({
				title: 'LLM Bridge: 选择 API Key 备份文件（JSON）',
				canSelectFiles: true,
				canSelectMany: false,
				defaultUri,
				filters: { JSON: ['json'] },
			});
			if (!picked || picked.length === 0) {
				return;
			}
			const uri = picked[0];
			let entries: Record<string, string>;
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				entries = parseKeyImportFile(new TextDecoder().decode(bytes));
			} catch (error) {
				void vscode.window.showErrorMessage(
					`[LLM Bridge] 无法读取备份文件：${error instanceof Error ? error.message : String(error)}`
				);
				return;
			}
			let imported = 0;
			for (const [groupId, key] of Object.entries(entries)) {
				await context.secrets.store(endpointSecretKey(groupId), key);
				imported++;
			}
			if (imported === 0) {
				void vscode.window.showWarningMessage('[LLM Bridge] 备份文件中没有有效的 API Key 条目');
				return;
			}
			provider.refreshModelPicker();
			const action = await vscode.window.showWarningMessage(
				`[LLM Bridge] 已导入 ${imported} 个 API Key 到系统钥匙串。是否删除备份文件？`,
				{ modal: false },
				'删除'
			);
			if (action === '删除') {
				await vscode.workspace.fs.delete(uri);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('llm-bridge')) {
				invalidateApiKeyCache();
				provider.refreshModelPicker();
				provider.resetVision();
			}
		}),
		// 多窗口同步：另一窗口增删 SecretStorage 中的 Key 时刷新本窗口模型选择器
		context.secrets.onDidChange(() => {
			invalidateApiKeyCache();
			provider.refreshModelPicker();
		})
	);

	// 先激活 Copilot Chat 再刷新模型选择器：确保 configurationSchema（思考强度下拉）等
	// 元数据立即生效而不是走宿主缓存（参考 deepseek-v4-for-copilot）。
	await activateCopilotChat();
	provider.refreshModelPicker();
}

export async function deactivate(): Promise<void> {
	await activeProvider?.prepareForDeactivate();
	activeProvider = undefined;
}

/** 激活 Copilot Chat，使后续 refreshModelPicker 能被实时监听者接收到。 */
async function activateCopilotChat(): Promise<void> {
	try {
		await vscode.extensions.getExtension('github.copilot-chat')?.activate();
	} catch {
		// 忽略：刷新可能延迟，但不阻塞启动
	}
}

/**
 * 统一添加流程（所有预设与自定义端点共用）：
 * 填 baseUrl + Key → 拉取 /models → 勾选多个模型 → 设定思考/上下文 → 生成一组共享 Key 的端点。
 * @param preset 预填 baseUrl、默认名称与思考参数；不传则完全手动输入。
 */
async function addCustomEndpoint(
	context: vscode.ExtensionContext,
	provider: LlmBridgeProvider,
	config: vscode.WorkspaceConfiguration,
	preset?: {
		baseUrl: string;
		name: string;
		thinking?: boolean;
		sendThinkingParam?: boolean;
		cost?: (model: string) => ModelCost | undefined;
	}
): Promise<void> {
	const baseUrlInput = await vscode.window.showInputBox({
		title: 'OpenAI 兼容端点 baseUrl',
		placeHolder: '如 https://opencode.ai/zen/v1 或 http://127.0.0.1:8080/v1',
		value: preset?.baseUrl ?? '',
		ignoreFocusOut: true,
	});
	if (baseUrlInput === undefined) {
		return;
	}
	const base = baseUrlInput.trim().replace(/\/+$/, '');
	if (!base) {
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
	const key = apiKey.trim();

	// 拉取可用模型列表（GET /models）并多选勾选
	const fetched = await fetchModelList(base, key);
	let selected: string[] = [];
	if (fetched.length > 0) {
		const pickedModels = await vscode.window.showQuickPick(
			fetched.map((id) => ({ label: id, description: '可选模型' })),
			{
				title: '勾选要使用的模型（输入可过滤）',
				placeHolder: `共 ${fetched.length} 个可用模型，可勾选多个（Esc 后手动输入）`,
				ignoreFocusOut: true,
				matchOnDescription: true,
				canPickMany: true,
			}
		);
		if (pickedModels) {
			selected = pickedModels.map((p) => p.label);
		}
	}
	if (selected.length === 0) {
		const manual = await vscode.window.showInputBox({
			title:
				fetched.length > 0
					? '手动输入模型 ID（未勾选，可逗号分隔多个）'
					: '模型 ID（未能自动获取列表，可逗号分隔多个）',
			placeHolder: '如 deepseek-v4-pro, deepseek-v4-flash',
			ignoreFocusOut: true,
		});
		if (manual === undefined) {
			return;
		}
		selected = manual
			.split(/[,，]/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (selected.length === 0) {
			return;
		}
	}

	// 思考模式：默认开启（具体强度由 VS Code 选择器中的「思考强度」下拉控制：关/高/最大）。
	// 不再在接入时询问「是否支持思考」——那会把不支持标记的端点一刀切关掉思考。
	// 预设可显式覆盖：如 MiMo 不支持 reasoning_effort 参数则 sendThinkingParam:false。
	const thinking = preset?.thinking ?? true;
	const sendThinkingParam = preset?.sendThinkingParam ?? true;

	const ctxInput = await vscode.window.showInputBox({
		title: '上下文窗口（tokens，可留空 = 默认 128K）',
		placeHolder: '如 1000000（1M）；留空使用默认 128K',
		ignoreFocusOut: true,
		validateInput: (v) => {
			const t = v.trim();
			if (!t) {
				return undefined;
			}
			const n = Number(t);
			return Number.isInteger(n) && n > 0 ? undefined : '请输入正整数（tokens）';
		},
	});
	if (ctxInput === undefined) {
		return;
	}
	const contextWindow = ctxInput.trim() ? Math.floor(Number(ctxInput)) : 0;

	let nameBase = preset?.name;
	if (nameBase === undefined) {
		const input = await vscode.window.showInputBox({
			title: '显示名称（可留空，默认用第一个模型 ID）',
			placeHolder: selected[0],
			ignoreFocusOut: true,
		});
		if (input === undefined) {
			return; // 取消
		}
		nameBase = input;
	}
	const name = nameBase.trim() || selected[0];
	// 自定义了显示名时按「名称 · 模型ID」展示；留空（默认取第一个模型 ID）时各模型直接以自身 ID 显示，
	// 避免出现「deepseek-v4-flash-free · longcat-2.0-free」这类两个模型名拼在一起。
	const hasCustomName = Boolean(nameBase && nameBase.trim());

	// 生成一组共享 Key 的端点（group 相同，Key 只存一份）
	const group = `g-${Date.now().toString(36)}`;
	const current = config.get<unknown[]>('endpoints', []);
	const newEps = selected.map((model, i) => {
		const modelCost = preset?.cost ? preset.cost(model) : undefined;
		return {
			id: `${group}-${i}`,
			name: hasCustomName ? `${name} · ${model}` : model,
			baseUrl: base,
			model,
			contextWindow,
			toolCalling: true,
			imageInput: false,
			thinking,
			sendThinkingParam,
			group,
			...(modelCost ? { cost: modelCost } : {}),
		};
	});
	await config.update('endpoints', [...current, ...newEps], vscode.ConfigurationTarget.Global);
	if (key) {
		await context.secrets.store(endpointSecretKey(group), key);
	}
	provider.refreshModelPicker();
	void vscode.window.showInformationMessage(
		`[LLM Bridge] ${name} 已添加 ${selected.length} 个模型 ✓（${selected.join('、')}）模型选择器 → LLM Bridge`
	);
}

/** 一次性迁移：旧版内置 DeepSeek / MiMo Key 配置转为统一端点（Key 按组迁移）。 */
async function migrateLegacyProviders(context: vscode.ExtensionContext): Promise<void> {
	try {
		const config = vscode.workspace.getConfiguration('llm-bridge');
		const endpoints = config.get<unknown[]>('endpoints', []);
		// 合并式更新：多次追加后一次性写入，避免后一次覆盖前一次
		let next = [...endpoints];
		let changed = false;
		const hasHost = (host: string): boolean =>
			next.some((e) => String((e as { baseUrl?: unknown }).baseUrl ?? '').includes(host));

		const deepseekKey = await readApiKey(context, SECRET_KEYS.deepseek, 'deepseekApiKey');
		if (deepseekKey && !hasHost('deepseek.com')) {
			const group = 'deepseek-official';
			next = [
				...next,
				{ id: `${group}-pro`, name: 'DeepSeek 官方 · V4 Pro', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', contextWindow: 1000000, toolCalling: true, imageInput: false, thinking: true, sendThinkingParam: true, group, cost: deepseekCost('deepseek-v4-pro') },
				{ id: `${group}-flash`, name: 'DeepSeek 官方 · V4 Flash', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', contextWindow: 1000000, toolCalling: true, imageInput: false, thinking: true, sendThinkingParam: true, group, cost: deepseekCost('deepseek-v4-flash') },
			];
			await context.secrets.store(endpointSecretKey(group), deepseekKey);
			await context.secrets.delete(SECRET_KEYS.deepseek);
			await config.update('deepseekApiKey', '', vscode.ConfigurationTarget.Global);
			changed = true;
		}

		const mimoKey = await readApiKey(context, SECRET_KEYS.mimo, 'mimoApiKey');
		if (mimoKey && !hasHost('xiaomimimo.com')) {
			const group = 'mimo-tokenplan';
			next = [
				...next,
				{ id: `${group}-pro`, name: 'MiMo Token Plan · v2.5 Pro', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', contextWindow: 1000000, toolCalling: true, imageInput: false, thinking: true, sendThinkingParam: false, group },
				{ id: `${group}-m`, name: 'MiMo Token Plan · v2.5', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5', contextWindow: 1000000, toolCalling: true, imageInput: true, thinking: true, sendThinkingParam: false, group },
			];
			await context.secrets.store(endpointSecretKey(group), mimoKey);
			await context.secrets.delete(SECRET_KEYS.mimo);
			await config.update('mimoApiKey', '', vscode.ConfigurationTarget.Global);
			changed = true;
		}

		if (changed) {
			await config.update('endpoints', next, vscode.ConfigurationTarget.Global);
			invalidateApiKeyCache();
		}
	} catch (error) {
		// 迁移失败不阻塞启动：写日志，仅首次弹通知引导用户重新添加（避免每次启动打扰）
		output.appendLine(
			`[迁移] 旧配置迁移失败：${error instanceof Error ? error.message : String(error)}`
		);
		const flag = 'migrationFailedNotified';
		if (!context.globalState.get(flag)) {
			await context.globalState.update(flag, true);
			void vscode.window.showWarningMessage(
				'[LLM Bridge] 旧版配置迁移失败，请使用「LLM Bridge: 添加模型（预设）」重新添加模型。'
			);
		}
	}
}

/**
 * 拉取 OpenAI 兼容端点的可用模型列表（GET /models）。
 * 失败时提示原因并返回空数组（调用方回退到手动输入）。
 */
async function fetchModelList(baseUrl: string, apiKey: string): Promise<string[]> {
	const client = new OpenAIClient(baseUrl, apiKey);
	try {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: '[LLM Bridge] 正在获取可用模型列表...',
			},
			() => client.listModels()
		);
	} catch (error) {
		void vscode.window.showWarningMessage(
			`[LLM Bridge] 未能自动获取模型列表（${error instanceof Error ? error.message : String(error)}），将手动输入模型 ID。`
		);
		return [];
	}
}

/**
 * DeepSeek 官方 V4 价格表（¥/1M tokens：input=输入缓存未命中、cache=缓存命中、output=输出）。
 * 数据来源：DeepSeek 官方定价页（2026-08，与 deepseek-v4-for-copilot 的 CNY 定价一致）；
 * 官方提示近期可能调价，如有出入以官方为准。仅对能确认官方价格的模型返回，其余返回 undefined。
 */
function deepseekCost(model: string): ModelCost | undefined {
	const table: Record<string, ModelCost> = {
		'deepseek-v4-flash': { input: '¥1', output: '¥2', cache: '¥0.02', category: 'low' },
		'deepseek-v4-pro': { input: '¥3', output: '¥6', cache: '¥0.025', category: 'low' },
	};
	return table[model];
}
