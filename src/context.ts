import { countMessageChars, messageChars, type OpenAIMessage } from './convert';

/**
 * 若消息总长度超出上下文预算，从最早的消息开始丢弃，保留最近的内容。
 * 若单条消息本身就超预算（如 Copilot 的首条大请求），则对其内容做尾部截断兜底，避免 400。
 */
export function trimMessagesToContext(
	messages: OpenAIMessage[],
	contextWindow: number,
	charsPerToken: number
): OpenAIMessage[] {
	// 保守估算：代码类内容通常约 3 字符/token，用更小比率预留更充分余量
	const conservativeCharsPerToken = Math.min(charsPerToken, 3.0);
	// 预留 15% 余量给输出与聊天模板开销
	const budget = Math.floor(contextWindow * conservativeCharsPerToken * 0.85);
	if (countMessageChars(messages) <= budget) {
		return messages;
	}
	const kept: OpenAIMessage[] = [];
	let used = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const chars = messageChars(msg);
		if (kept.length > 0 && used + chars > budget) {
			break;
		}
		kept.unshift(msg);
		used += chars;
	}
	if (kept.length === 0 && messages.length > 0) {
		kept.push(messages[messages.length - 1]);
	}
	// 最后一条消息仍超预算：截断其内容（保留尾部，即用户最新意图），作为兜底
	const last = kept[kept.length - 1];
	if (last && messageChars(last) > budget) {
		if (typeof last.content === 'string' && last.content.length > budget) {
			last.content =
				last.content.slice(-Math.floor(budget * 0.75)) + '\n\n[...内容过长，已自动截断...]';
		}
	}
	kept.unshift({ role: 'user', content: '[上下文超限，较早的消息已自动截断]' });
	return kept;
}
