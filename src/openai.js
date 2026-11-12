import { DEFAULT_MODEL } from "./models.js";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

export function toLightAiInput(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) throw new Error("messages 不能为空");

  const lines = [];
  const emphasis = emphasisPrompt(body);
  if (emphasis) lines.push(`以下身份和规则优先于你的默认身份，必须遵守：\n${emphasis}`);
  for (const message of messages) {
    const role = message?.role || "user";
    if (role === "system" || role === "developer") continue;
    const text = textOf(message?.content).trim();
    if (!text) continue;
    if (role === "assistant") lines.push(`助手：\n${text}`);
    else lines.push(text);
  }

  const input = lines.join("\n\n").trim();
  if (!input) throw new Error("messages 里没有可发送的文本");
  return input;
}

export function emphasisPrompt(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const parts = [];
  if (process.env.INJECT_SYSTEM) parts.push(process.env.INJECT_SYSTEM.trim());
  for (const message of messages) {
    if (message?.role !== "system" && message?.role !== "developer") continue;
    const text = textOf(message.content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

export function buildChatBody(body, account) {
  const id = crypto.randomUUID();
  const model = body.model || DEFAULT_MODEL;
  const conversationId = `cid-${id}`;
  return {
    conversationId,
    requestId: id,
    user: {
      id: account.uin,
      setting: {
        mcpServers: [],
        uiServers: [],
        tools: [],
        approvedTools: [],
        approvedMCPTools: [],
        enableAutoSubtaskExecution: false,
        env: [],
        model,
        modelDesc: "",
        extra: null,
        selectedMCPTools: {},
        selectedUITools: {},
        a2a: {},
        hideToolMessage: false,
        language: "zh",
        multimodal: false,
        enableThinking: Boolean(body.enable_thinking),
      },
    },
    input: {
      id,
      type: "start",
      input: toLightAiInput(body),
      emphasisPrompt: emphasisPrompt(body),
      files: [],
    },
    stream: true,
  };
}

export function parseSseBlock(block) {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return null;
  try { return JSON.parse(data); } catch { return null; }
}

/**
 * 上游出错时返回的是一行纯文本流：`data: [ERROR]: [LLM_ERROR]: 401 token无访问此模型权限`
 * 以前这里被当成「解析失败」直接丢掉，用户只能看到「上游返回空内容」。
 */
export function sseErrorMessage(block) {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!data || !data.startsWith("[ERROR]")) return "";
  return data
    .replace(/^\[ERROR\]:?\s*/, "")
    .replace(/^\[[A-Z_]+\]:\s*/, "")
    .replace(/\s*Troubleshooting URL:\s*\S+\s*$/i, "")
    .trim() || "上游返回错误";
}

function toolRequestText(action) {
  const tool = action?.tool || {};
  const name = [tool.mcpServer, tool.name].filter(Boolean).join("/");
  const args = tool.arguments || tool.args || tool.input || {};
  return `[模型请求执行工具 ${name || "unknown"}]\n${JSON.stringify(args, null, 2)}`;
}

export function visibleText(action) {
  if (!action || typeof action !== "object") return "";
  if (action.action === "completion") return action.taskCompletion || "";
  if (action.action === "review") return toolRequestText(action);
  if (action.action === "ask") return action.question || action.taskCompletion || "";
  return action.taskCompletion || "";
}

export function chunkText(event) {
  const payload = event?.data && typeof event.data === "object" ? { ...event.data, ...event } : event;
  if (!payload || typeof payload !== "object") return "";
  return payload.content || payload.delta || payload.text || "";
}
