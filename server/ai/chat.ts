import { AI } from '../config.ts';
import type { ChatRequest } from '../../shared/types.ts';

const SYSTEM_PROMPT = `你是一位资深的日语教师兼语言学者，正在为一个「日语句子语法解析工具」提供答疑服务。用户是中文母语者。

回答要求：
1. 用中文回答，日语原文、例句保留日文并在需要时附振假名（用「漢字（かんじ）」的形式）。
2. 讲语法时先给结论，再给依据。指出该表达的构成成分（词干 + 词尾 / 助动词 / 助词），说明每个成分的作用。
3. 涉及助词时，明确说明它连接的前项和后项分别是什么成分、承担什么语法角色。
4. 举例要真实自然，不要编造不合语法的句子。给例句时附中文翻译。
5. 如果用户的问题基于工具给出的分析结果，而你认为那个分析有误，直接指出并说明正确的分析。
6. 简洁。不要复述用户的问题，不要写「好的，我来为你解释」这类开场白。
7. 用 Markdown 组织答案，善用列表和加粗，但不要滥用标题。`;

function buildContextMessage(context: ChatRequest['context']): string | null {
  if (!context) return null;
  const parts: string[] = [];
  if (context.focusWord) {
    const w = context.focusWord;
    const brief = w.brief?.length ? `\n  词典释义：${w.brief.join(' / ')}` : '';
    parts.push(
      `【用户当前关注的词】${w.surface}（${w.reading}）\n  辞書形：${w.lemma}\n  词性：${w.posLabel}${brief}`,
    );
  }
  if (context.sentence) parts.push(`【该词所在的句子】\n${context.sentence}`);
  if (context.fullText && context.fullText !== context.sentence) {
    parts.push(`【用户正在分析的全文】\n${context.fullText}`);
  }
  if (parts.length === 0) return null;
  return `以下是工具当前的分析上下文，供你参考（用户看得到这些内容，不必复述）：\n\n${parts.join('\n\n')}`;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 流式接口。
 * 兼容 OpenAI / DeepSeek / 智谱 / Moonshot / OpenRouter / Ollama。
 */
export async function streamChat(
  req: ChatRequest,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  if (!AI.configured) {
    handlers.onError('未配置 AI：请在项目根目录的 .env 中设置 AI_API_KEY（可参考 .env.example）。');
    handlers.onDone();
    return;
  }

  const messages: { role: string; content: string }[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const contextMsg = buildContextMessage(req.context);
  if (contextMsg) messages.push({ role: 'system', content: contextMsg });
  for (const m of req.messages) {
    if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
    }
  }

  let res: Response;
  try {
    res = await fetch(`${AI.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AI.apiKey}`,
      },
      body: JSON.stringify({ model: AI.model, messages, stream: true, temperature: 0.3 }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return handlers.onDone();
    handlers.onError(`无法连接 AI 服务（${AI.baseUrl}）：${(err as Error).message}`);
    return handlers.onDone();
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    handlers.onError(`AI 服务返回 ${res.status}${detail ? `：${detail.slice(0, 500)}` : ''}`);
    return handlers.onDone();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔；这里按行处理即可，因为 data 字段总是单行 JSON
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null } }[];
            error?: { message?: string };
          };
          if (json.error?.message) {
            handlers.onError(json.error.message);
            continue;
          }
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) handlers.onDelta(delta);
        } catch {
          // 忽略无法解析的片段，不中断整条流
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) handlers.onError(`读取 AI 响应失败：${(err as Error).message}`);
  } finally {
    handlers.onDone();
  }
}
