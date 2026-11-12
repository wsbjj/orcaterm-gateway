import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { AccountPool } from "./pool.js";
import { DEFAULT_MODEL, MODELS } from "./models.js";
import { buildChatBody, chunkText, parseSseBlock, visibleText } from "./openai.js";
import { assistantUrl, readUpstreamError, upstreamFailure, upstreamHeaders, upstreamJson } from "./upstream.js";

import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || new URL("../data/accounts.json", import.meta.url);
const WEB_INDEX = new URL("./web/index.html", import.meta.url);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, error) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  sendJson(response, status, { error: { message: error.message, type: "proxy_error" } });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function completionId() {
  return `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function assistantText(raw) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    const text = visibleText(parsed);
    return text || raw;
  } catch {
    return raw;
  }
}

async function readUpstreamChat(response) {
  if (!response.ok || !response.body) throw await readUpstreamError(response);
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    const payload = await response.json();
    const failure = upstreamFailure(payload);
    if (failure) throw failure;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event) continue;
      if (event.code && event.code !== 0 && event.code !== 200) throw new Error(event.message || event.error?.message || `上游返回 ${event.code}`);
      full += chunkText(event);
    }
  }
  return full;
}

async function handleChat(request, response, pool) {
  const body = await readBody(request);
  const account = pool.next();
  const model = body.model || DEFAULT_MODEL;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let full = "";
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const chatBody = buildChatBody(body, account);
    try {
      const upstream = await fetch(assistantUrl("/chat", account), {
        method: "POST",
        headers: { ...upstreamHeaders(account, { stream: true, seqId: chatBody.requestId }), "Content-Type": "application/json" },
        body: JSON.stringify(chatBody),
      });
      full = await readUpstreamChat(upstream);
      const text = assistantText(full);
      const persona = `${process.env.INJECT_SYSTEM || ""}\n${JSON.stringify(body.messages || [])}`;
      const rejectedPersona = /你不是 OrcaTerm AI|不要自称 OrcaTerm AI|绝不自称 OrcaTerm AI/.test(persona) && /我是 OrcaTerm AI/.test(text);
      if (text.trim() && !rejectedPersona) break;
      lastError = new Error(rejectedPersona ? "上游仍使用默认身份" : "上游返回空内容");
    } catch (error) {
      lastError = error;
      if (attempt === 3 || (error.status && error.status < 500)) break;
    }
  }
  if (!assistantText(full).trim()) {
    pool.mark(account, false);
    throw lastError || new Error("上游返回空内容");
  }

  const stream = body.stream !== false;
  if (stream) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Orca-Account": account.id,
    });
    sse(response, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  }

  pool.mark(account, true);
  if (process.env.DEBUG_UPSTREAM) console.error(`UPSTREAM ${JSON.stringify(full)}`);
  const content = assistantText(full);
  if (stream) {
    if (content) sse(response, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
    sse(response, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  sendJson(response, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function handleAccounts(request, response, pool, url) {
  if (request.method === "GET") return sendJson(response, 200, { accounts: pool.list() });

  const body = await readBody(request);
  const id = decodeURIComponent(url.pathname.split("/").at(-1) || "");
  if (request.method === "DELETE" && id && id !== "accounts") {
    const removed = await pool.remove(id);
    return sendJson(response, removed ? 200 : 404, { removed });
  }

  const text = body.raw || JSON.stringify(body.accounts || body);
  if (request.method === "PUT") return sendJson(response, 200, { accounts: await pool.replace(text) });
  if (request.method === "POST") return sendJson(response, 200, { accounts: await pool.add(text) });
  sendJson(response, 405, { error: { message: "不支持的方法" } });
}

async function sendWebIndex(response) {
  const body = await readFile(WEB_INDEX, "utf8");
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export function createApp(pool) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/index.html")) {
        return await sendWebIndex(response);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, accounts: pool.list().length });
      }
      if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return sendJson(response, 200, { object: "list", data: MODELS.map((model) => ({ ...model, object: "model" })) });
      }
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
        if (request.method !== "POST") return sendJson(response, 405, { error: { message: "只接受 POST" } });
        return await handleChat(request, response, pool);
      }
      if (url.pathname === "/accounts" || url.pathname.startsWith("/accounts/")) {
        return await handleAccounts(request, response, pool, url);
      }
      if (request.method === "GET" && url.pathname === "/upstream/status") {
        const account = pool.next();
        const payload = await upstreamJson(account, "/stream/status");
        return sendJson(response, 200, { account: account.id, upstream: payload });
      }
      sendJson(response, 404, { error: { message: "未找到接口" } });
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.end();
    }
  });
}

process.on("uncaughtException", (error) => {
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  process.exit(1);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new AccountPool(ACCOUNTS_FILE);
  await pool.load();
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({ accounts: pool.list().length, models: MODELS.length }));
  } else {
    const server = createApp(pool);
    server.on("error", (error) => {
      console.error(`proxy failed: ${error.message}`);
      process.exit(1);
    });
    server.listen(PORT, HOST, () => {
      console.log(`OrcaTerm proxy listening on http://${HOST}:${PORT}`);
      console.log(`accounts: ${pool.list().length}`);
    });
  }
}
