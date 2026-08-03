import * as vscode from 'vscode';

/** SecretStorage 中使用的供应商 key 常量（旧版配置名对应关系）。 */
export const SECRET_KEYS = {
	deepseek: 'llm-bridge.deepseekApiKey',
	mimo: 'llm-bridge.mimoApiKey',
	openai: 'llm-bridge.openaiApiKey',
} as const;

/** 旧版 settings.json 配置项 → SecretStorage key 的映射。 */
const LEGACY_KEY_MAP: ReadonlyArray<{ configName: string; secretKey: string }> = [
	{ configName: 'deepseekApiKey', secretKey: SECRET_KEYS.deepseek },
	{ configName: 'mimoApiKey', secretKey: SECRET_KEYS.mimo },
	{ configName: 'openaiApiKey', secretKey: SECRET_KEYS.openai },
];

/** 自定义端点在 SecretStorage 中存储 apiKey 的 key（按端点 id 区分）。 */
export function endpointSecretKey(id: string): string {
	return `llm-bridge.endpoint.${id}.apiKey`;
}

/**
 * 一次性迁移：把 settings.json 中已填写的旧 key 迁入 SecretStorage，并清空配置项。
 * 迁移失败（如无 UI 会话）时静默跳过，读取逻辑会退回配置兜底。
 */
export async function migrateLegacyKeys(context: vscode.ExtensionContext): Promise<void> {
	const config = vscode.workspace.getConfiguration('llm-bridge');
	for (const { configName, secretKey } of LEGACY_KEY_MAP) {
		try {
			if (await context.secrets.get(secretKey)) {
				continue;
			}
			const legacy = config.get<string>(configName);
			if (legacy) {
				await context.secrets.store(secretKey, legacy);
				await config.update(configName, '', vscode.ConfigurationTarget.Global);
			}
		} catch {
			// SecretStorage 不可用时静默跳过，读取时退回配置兜底
		}
	}
}

/**
 * 读取 API Key：SecretStorage 优先，其次配置兜底（迁移前或 SecretStorage 不可用时）。
 * 返回空串表示无 key（本地端点无需鉴权）。
 */
export async function readApiKey(
	context: vscode.ExtensionContext,
	secretKey: string,
	configName?: string
): Promise<string> {
	try {
		const secret = await context.secrets.get(secretKey);
		if (secret) {
			return secret;
		}
	} catch {
		// 忽略，退回配置
	}
	if (configName) {
		const cfg = vscode.workspace.getConfiguration('llm-bridge').get<string>(configName);
		if (cfg) {
			return cfg;
		}
	}
	return '';
}
