import type { ModelConfig } from './config';

interface DeepSeekBalanceInfo {
	currency: string;
	total_balance: string;
	granted_balance: string;
	topped_up_balance: string;
}

interface DeepSeekBalanceResponse {
	is_available: boolean;
	balance_infos?: DeepSeekBalanceInfo[];
}

/** 是否为 DeepSeek 官方端点（支持 /user/balance 余额查询）。 */
export function isDeepSeekEndpoint(model: ModelConfig): boolean {
	return /api\.deepseek\.com/i.test(model.baseUrl);
}

/** 是否为 OpenRouter 端点（支持 /api/v1/credits 余额查询）。 */
export function isOpenRouterEndpoint(model: ModelConfig): boolean {
	return /openrouter\.ai/i.test(model.baseUrl);
}

/** 通用余额查询：按端点类型自动选择余额 API；失败时抛出错误。 */
export async function queryBalance(model: ModelConfig): Promise<string> {
	if (isOpenRouterEndpoint(model)) {
		return queryOpenRouterBalance(model);
	}
	// DeepSeek 官方及多数 OpenAI 兼容网关：GET {base}/user/balance
	return queryDeepSeekStyleBalance(model);
}

/** OpenRouter：GET https://openrouter.ai/api/v1/credits */
async function queryOpenRouterBalance(model: ModelConfig): Promise<string> {
	const response = await fetch('https://openrouter.ai/api/v1/credits', {
		headers: model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {},
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
	}
	const data = (await response.json()) as {
		credits?: { total?: number; used?: number; remaining?: number };
	};
	if (!data.credits) {
		throw new Error('响应缺少 credits 字段');
	}
	const c = data.credits;
	const parts = [`总额 $${c.total ?? 0}`];
	if (c.used) {
		parts.push(`已用 $${c.used}`);
	}
	if (c.remaining !== undefined) {
		parts.push(`剩余 $${c.remaining}`);
	}
	return parts.join(' · ');
}

/** DeepSeek 风格余额：GET {base}/user/balance（兼容多数 OpenAI 网关）。 */
async function queryDeepSeekStyleBalance(model: ModelConfig): Promise<string> {
	const base = model.baseUrl.replace(/\/v\d+\/?$/i, ''); // 去掉 /v1
	const url = `${base}/user/balance`;
	const response = await fetch(url, {
		headers: model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {},
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
	}
	const data = (await response.json()) as DeepSeekBalanceResponse;
	if (!Array.isArray(data.balance_infos) || data.balance_infos.length === 0) {
		return `可用: ${data.is_available ? '是' : '否'}（无余额明细）`;
	}
	const lines = data.balance_infos.map((info) => {
		const parts = [`${info.currency}: 总额 ${info.total_balance}`];
		if (Number(info.granted_balance) > 0) {
			parts.push(`赠送 ${info.granted_balance}`);
		}
		if (Number(info.topped_up_balance) > 0) {
			parts.push(`充值 ${info.topped_up_balance}`);
		}
		return parts.join(' · ');
	});
	return lines.join('\n');
}
