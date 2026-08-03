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

/** 查询 DeepSeek 账户余额。返回人类可读文本；失败时抛出错误。 */
export async function queryDeepSeekBalance(model: ModelConfig): Promise<string> {
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
