import * as vscode from 'vscode';
import { getProviderSettings, type CustomEndpoint } from './config';
import { listVisionModelOptions } from './vision';
import { endpointSecretKey } from './keys';

/**
 * LLM Bridge 设置面板（Webview）。
 *
 * 命令收敛后，命令面板只保留少量主命令（设置面板 / 添加模型 / 刷新模型），
 * 其余低频功能（管理模型 / 测试连通性 / 查询余额 / 配置视觉代理 / 导入 Key）
 * 收进此面板统一操作。
 *
 * 面板通信：前端 postMessage 请求状态 / 执行操作，扩展处理后再回推完整状态。
 */

interface EndpointView {
	id: string;
	name: string;
	model: string;
	baseUrl: string;
	imageInput: boolean;
	thinking: boolean;
	contextWindow: number;
}

interface PanelState {
	endpoints: EndpointView[];
	visionModels: { key: string; name: string; vendor: string }[];
	visionModel: string;
}

interface PanelMessage {
	type: string;
	id?: string;
	field?: 'imageInput' | 'thinking';
	command?: string;
	visionKey?: string;
}

export class SettingsPanel {
	private static current: SettingsPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly context: vscode.ExtensionContext;

	static createOrShow(context: vscode.ExtensionContext): void {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		if (SettingsPanel.current) {
			SettingsPanel.current.panel.reveal(column);
			void SettingsPanel.current.refresh();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'llm-bridge-settings',
			'LLM Bridge 设置',
			column,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			}
		);
		SettingsPanel.current = new SettingsPanel(panel, context);
	}

	constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
		this.panel = panel;
		this.context = context;
		this.panel.webview.html = this.buildHtml();
		this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => {
			void this.handleMessage(msg);
		});
		this.panel.onDidDispose(() => {
			SettingsPanel.current = undefined;
		});
		void this.refresh();
	}

	/** 拉取最新状态并推送给前端。 */
	async refresh(): Promise<void> {
		try {
			const settings = await getProviderSettings(this.context);
			const visionModels = await listVisionModelOptions(this.context);
			const config = vscode.workspace.getConfiguration('llm-bridge');
			const visionModel = config.get<string>('visionModel', '');
			const state: PanelState = {
				endpoints: settings.endpoints.map((ep) => ({
					id: ep.id,
					name: ep.name,
					model: ep.model,
					baseUrl: ep.baseUrl,
					imageInput: ep.imageInput,
					thinking: ep.thinking,
					contextWindow: ep.contextWindow,
				})),
				visionModels: visionModels.map((v) => ({ key: v.key, name: v.name, vendor: v.vendor })),
				visionModel,
			};
			await this.panel.webview.postMessage({ type: 'state', ...state });
		} catch {
			// 面板可能已关闭，忽略
		}
	}

	private async handleMessage(msg: PanelMessage): Promise<void> {
		switch (msg.type) {
			case 'getState':
				await this.refresh();
				break;
			case 'toggleEndpoint':
				if (msg.id && msg.field) {
					await this.toggleEndpointField(msg.id, msg.field);
					await this.refresh();
				}
				break;
			case 'deleteEndpoint':
				if (msg.id) {
					await this.deleteEndpoint(msg.id);
					await this.refresh();
				}
				break;
			case 'setVisionModel':
				if (msg.visionKey) {
					await vscode.workspace
						.getConfiguration('llm-bridge')
						.update('visionModel', msg.visionKey, vscode.ConfigurationTarget.Global);
					await this.refresh();
				}
				break;
			case 'runCommand':
				if (msg.command) {
					try {
						// 命令内部多为模态流程（showQuickPick），await 其完成后刷新状态
						await vscode.commands.executeCommand(msg.command);
					} catch {
						// 忽略
					}
					setTimeout(() => void this.refresh(), 500);
				}
				break;
		}
	}

	/** 翻转端点的布尔字段（imageInput / thinking）。 */
	private async toggleEndpointField(id: string, field: 'imageInput' | 'thinking'): Promise<void> {
		const config = vscode.workspace.getConfiguration('llm-bridge');
		const current = config.get<unknown[]>('endpoints', []);
		const next = current.map((raw) => {
			const ep = raw as { id?: unknown } & Record<string, unknown>;
			if (String(ep.id ?? '') !== id) {
				return raw;
			}
			return { ...ep, [field]: !Boolean(ep[field]) };
		});
		await config.update('endpoints', next, vscode.ConfigurationTarget.Global);
	}

	/** 删除单个端点；若该共享 Key 组只剩这一个端点则一并清理 SecretStorage。 */
	private async deleteEndpoint(id: string): Promise<void> {
		const config = vscode.workspace.getConfiguration('llm-bridge');
		const current = config.get<unknown[]>('endpoints', []);
		const eps = current.map((raw) => raw as CustomEndpoint);
		const target = eps.find((e) => e.id === id);
		if (!target) {
			return;
		}
		const group = target.group || target.id;
		const sameGroupCount = eps.filter((e) => (e.group || e.id) === group).length;
		const next = eps.filter((e) => e.id !== id).map((e) => e as unknown);
		await config.update('endpoints', next, vscode.ConfigurationTarget.Global);
		if (sameGroupCount <= 1) {
			await this.context.secrets.delete(endpointSecretKey(group));
		}
	}

	// ---------- HTML ----------

	private buildHtml(): string {
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
	/* 跟随 VS Code 当前主题（深浅色自适应），不再手写配色 */
	* { box-sizing: border-box; }
	body {
		margin: 0; padding: 16px;
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		font-family: var(--vscode-font-family, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
		font-size: var(--vscode-font-size, 13px);
	}
	h1 { font-size: 18px; margin: 0 0 4px; }
	.sub { color: var(--vscode-descriptionForeground); margin: 0 0 16px; font-size: 12px; }
	.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
	button {
		background: var(--vscode-button-background); color: var(--vscode-button-foreground);
		border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
		padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.ghost {
		background: transparent; color: var(--vscode-textLink-foreground);
		border: 1px solid var(--vscode-input-border);
	}
	button.ghost:hover { background: var(--vscode-list-hoverBackground); }
	button.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-input-border); }
	button.danger:hover { background: var(--vscode-list-hoverBackground); }
	section { margin-bottom: 24px; }
	h2 { font-size: 14px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
	th { color: var(--vscode-descriptionForeground); font-weight: 500; font-size: 12px; }
	td.name { font-weight: 600; }
	td.model { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 12px; }
	td.url { color: var(--vscode-descriptionForeground); font-size: 11px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.switch { position: relative; display: inline-block; width: 32px; height: 18px; }
	.switch input { opacity: 0; width: 0; height: 0; }
	.slider { position: absolute; inset: 0; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 18px; transition: 0.2s; cursor: pointer; }
	.slider:before { content: ""; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: var(--vscode-input-foreground); opacity: 0.5; border-radius: 50%; transition: 0.2s; }
	.switch input:checked + .slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
	.switch input:checked + .slider:before { transform: translateX(14px); background: var(--vscode-button-foreground); opacity: 1; }
	.empty { color: var(--vscode-descriptionForeground); padding: 16px 0; text-align: center; }
	.badge { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
	.vision-row { display: flex; align-items: center; gap: 8px; }
	select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 6px 8px; font-size: 12px; flex: 1; max-width: 480px; font-family: inherit; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 6px; }
</style>
</head>
<body>
	<h1>LLM Bridge 设置</h1>
	<p class="sub">管理 OpenAI 兼容端点、视觉代理与 API Key。命令面板保留「添加模型 / 刷新模型」，其余功能集中在此。</p>

	<div class="toolbar">
		<button data-cmd="llm-bridge.addModel">＋ 添加模型</button>
		<button class="ghost" data-cmd="llm-bridge.manageModels">管理模型</button>
		<button class="ghost" data-cmd="llm-bridge.testConnection">测试连通性</button>
		<button class="ghost" data-cmd="llm-bridge.checkBalance">查询余额</button>
		<button class="ghost" data-cmd="llm-bridge.importApiKeys">导入 API Key</button>
		<button class="ghost" data-cmd="llm-bridge.refreshModels">刷新模型列表</button>
		<button class="ghost" data-cmd="llm-bridge.openNativeSettings">原生设置</button>
	</div>

	<section>
		<h2>端点</h2>
		<table>
			<thead><tr><th>名称</th><th>模型</th><th>Base URL</th><th>视觉 <span class="badge">imageInput</span></th><th>思考 <span class="badge">thinking</span></th><th></th></tr></thead>
			<tbody id="endpoints"></tbody>
		</table>
		<div id="endpointsEmpty" class="empty" hidden>暂无端点。点击上方「＋ 添加模型」开始。</div>
	</section>

	<section>
		<h2>视觉代理（纯文本模型看图用）</h2>
		<div class="vision-row">
			<select id="visionModel"></select>
			<button id="applyVision">应用</button>
		</div>
		<div class="hint">列表来自你配置的 imageInput=true 端点与宿主视觉模型。选择后纯文本模型发送图片时会调用该模型代看。</div>
	</section>

<script>
	(function () {
		var vscode = acquireVsCodeApi();
		var tbody = document.getElementById('endpoints');
		var empty = document.getElementById('endpointsEmpty');
		var visionSelect = document.getElementById('visionModel');
		var currentVision = '';

		function esc(s) {
			return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}

		function render(state) {
			// 端点
			tbody.innerHTML = '';
			empty.hidden = state.endpoints.length > 0;
			state.endpoints.forEach(function (ep) {
				var tr = document.createElement('tr');
				var nameTd = document.createElement('td');
				nameTd.className = 'name';
				nameTd.textContent = ep.name;
				var modelTd = document.createElement('td');
				modelTd.className = 'model';
				modelTd.textContent = ep.model;
				var urlTd = document.createElement('td');
				urlTd.className = 'url';
				urlTd.title = ep.baseUrl;
				urlTd.textContent = ep.baseUrl;
				var visTd = document.createElement('td');
				visTd.appendChild(switchEl('vis-' + ep.id, ep.imageInput, function (on) {
					send({ type: 'toggleEndpoint', id: ep.id, field: 'imageInput' });
				}));
				var thinkTd = document.createElement('td');
				thinkTd.appendChild(switchEl('think-' + ep.id, ep.thinking, function (on) {
					send({ type: 'toggleEndpoint', id: ep.id, field: 'thinking' });
				}));
				var delTd = document.createElement('td');
				var delBtn = document.createElement('button');
				delBtn.className = 'danger';
				delBtn.textContent = '删除';
				delBtn.addEventListener('click', function () {
					if (confirm('确定删除端点「' + ep.name + '」？')) {
						send({ type: 'deleteEndpoint', id: ep.id });
					}
				});
				delTd.appendChild(delBtn);
				tr.appendChild(nameTd); tr.appendChild(modelTd); tr.appendChild(urlTd);
				tr.appendChild(visTd); tr.appendChild(thinkTd); tr.appendChild(delTd);
				tbody.appendChild(tr);
			});

			// 视觉代理
			currentVision = state.visionModel || '';
			visionSelect.innerHTML = '';
			state.visionModels.forEach(function (v) {
				var opt = document.createElement('option');
				opt.value = v.key;
				opt.textContent = v.name + '（' + v.vendor + '）';
				opt.selected = v.key === currentVision;
				visionSelect.appendChild(opt);
			});
		}

		function switchEl(id, checked, onChange) {
			var label = document.createElement('label');
			label.className = 'switch';
			var input = document.createElement('input');
			input.type = 'checkbox';
			input.id = id;
			input.checked = !!checked;
			input.addEventListener('change', function () { onChange(input.checked); });
			var slider = document.createElement('span');
			slider.className = 'slider';
			label.appendChild(input); label.appendChild(slider);
			return label;
		}

		function send(msg) {
			vscode.postMessage(msg);
		}

		// 工具栏按钮 → 触发扩展命令
		document.querySelectorAll('button[data-cmd]').forEach(function (btn) {
			btn.addEventListener('click', function () {
				send({ type: 'runCommand', command: btn.getAttribute('data-cmd') });
			});
		});

		// 应用视觉代理
		document.getElementById('applyVision').addEventListener('click', function () {
			if (!visionSelect.value) return;
			send({ type: 'setVisionModel', visionKey: visionSelect.value });
		});

		// 初始拉取状态
		window.addEventListener('message', function (event) {
			var msg = event.data;
			if (msg && msg.type === 'state') {
				render(msg);
			}
		});
		send({ type: 'getState' });
	})();
</script>
</body>
</html>`;
	}
}
