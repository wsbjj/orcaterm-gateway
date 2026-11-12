import { buildChatBody, parseSseBlock, sseErrorMessage } from "./openai.js";
import { assistantUrl, upstreamHeaders } from "./upstream.js";

/**
 * 用一次极小的真实请求探测某个模型是否被该账号授权。
 * 上游没有额度/权限查询接口，只能用这种「打一枪」的方式确认。
 */
export async function probeModel(account, model, timeoutMs = 25000) {
  const body = buildChatBody({ model, messages: [{ role: "user", content: "hi" }] }, account);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(assistantUrl("/chat", account), {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...upstreamHeaders(account, { stream: true, seqId: body.requestId }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { model, ok: false, error: `HTTP ${response.status}` };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const error = sseErrorMessage(block);
        if (error) {
          await reader.cancel().catch(() => {});
          return { model, ok: false, error };
        }
        if (parseSseBlock(block)) {
          await reader.cancel().catch(() => {});
          return { model, ok: true, error: "" };
        }
      }
    }
    return { model, ok: false, error: "上游没有返回内容" };
  } catch (error) {
    return { model, ok: false, error: error.name === "AbortError" ? "探测超时" : error.message };
  } finally {
    clearTimeout(timer);
  }
}
