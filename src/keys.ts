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
 * API Key 读取缓存（secretKey → value）。
 * Windows 上 SecretStorage 每次 get 都走 IPC + DPAPI 解密（几十~几百 ms），
 * 同一 group 的多个端点共享同一 key 时会重复读同一把 key，导致端点加载缓慢。
 * 缓存命中后零成本；配置变更 / SecretStorage 变更时调用 invalidateApiKeyCache() 失效。
 */
const apiKeyCache = new Map<string, string>();

/** 使 API Key 缓存失效（配置变更或 SecretStorage 变更时调用）。 */
export function invalidateApiKeyCache(): void {
	apiKeyCache.clear();
}

/**
 * 解析 API Key 备份文件（JSON：`{ groupId: apiKey }`，groupId 为端点 group 或端点 id）。
 * 仅保留非空字符串条目（key 两端空白会去除）；JSON 语法错误抛错由调用方处理。
 * 用于「LLM Bridge: 从备份文件导入 API Key」命令（如 local → wolfox-labs 迁移后恢复 key）。
 */
export function parseKeyImportFile(text: string): Record<string, string> {
	const data = JSON.parse(text) as unknown;
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [groupId, key] of Object.entries(data as Record<string, unknown>)) {
		if (typeof key !== 'string') {
			continue;
		}
		const trimmed = key.trim();
		if (trimmed) {
			result[groupId] = trimmed;
		}
	}
	return result;
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
 * 结果按 secretKey 缓存；配置/SecretStorage 变更时由 invalidateApiKeyCache() 清空。
 */
export async function readApiKey(
	context: vscode.ExtensionContext,
	secretKey: string,
	configName?: string
): Promise<string> {
	const cached = apiKeyCache.get(secretKey);
	if (cached !== undefined) {
		return cached;
	}
	let result = '';
	try {
		const secret = await context.secrets.get(secretKey);
		if (secret) {
			result = secret;
		}
	} catch {
		// 忽略，退回配置
	}
	if (!result && configName) {
		const cfg = vscode.workspace.getConfiguration('llm-bridge').get<string>(configName);
		if (cfg) {
			result = cfg;
		}
	}
	apiKeyCache.set(secretKey, result);
	return result;
}
