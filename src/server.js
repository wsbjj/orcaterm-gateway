import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { findBrowser } from "./browser.js";
import { ConfigStore } from "./config.js";
import { LoginManager } from "./login.js";
import { AccountPool } from "./pool.js";
import { probeModel } from "./probe.js";
import { UsageStore } from "./usage.js";
import { DEFAULT_MODEL, MODELS } from "./models.js";
import { buildChatBody, chunkText, parseSseBlock, sseErrorMessage, visibleText } from "./openai.js";
import { assistantUrl, readUpstreamError, upstreamFailure, upstreamHeaders } from "./upstream.js";

import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || new URL("../data/accounts.json", import.meta.url);
const USAGE_FILE = process.env.USAGE_FILE || new URL("../data/usage.json", import.meta.url);
const CONFIG_FILE = process.env.CONFIG_FILE || new URL("../data/config.json", import.meta.url);
const WEB_INDEX = new URL("./web/index.html", import.meta.url);

const ADMIN_PATHS = ["/accounts", "/login", "/usage", "/models/probe", "/config"];

function bearer(request) {
  const header = String(request.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function adminKeyOf(request) {
  return bearer(request) || String(request.headers["x-admin-key"] || "");
}

function apiKeyOf(request) {
  return bearer(request) || String(request.headers["x-api-key"] || "");
}

function isAdminPath(pathname) {
  return ADMIN_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

function isApiPath(pathname) {
  return pathname === "/chat/completions" || pathname === "/models" || pathname.startsWith("/v1/");
}

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
      if (!event) {
        const message = sseErrorMessage(block);
        if (message) {
          const error = new Error(message);
          error.status = 502;
          error.noRetry = true;
          throw error;
        }
        continue;
      }
      if (event.code && event.code !== 0 && event.code !== 200) throw new Error(event.message || event.error?.message || `上游返回 ${event.code}`);
      full += chunkText(event);
    }
  }
  return full;
}

async function handleChat(request, response, pool, usage) {
  const body = await readBody(request);
  const account = pool.next();
  const model = body.model || DEFAULT_MODEL;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let full = "";
  let lastError = null;
  let promptChars = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const chatBody = buildChatBody(body, account);
    promptChars = String(chatBody.input.input || "").length;
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
      if (error.noRetry || attempt === 3 || (error.status && error.status < 500)) break;
    }
  }
  if (!assistantText(full).trim()) {
    pool.mark(account, false);
    const error = lastError || new Error("上游返回空内容");
    usage.record({ account: account.uin, model, promptChars, ok: false, error: error.message });
    throw error;
  }

  const content = assistantText(full);
  const prompt = String(body.messages || "").length;
  usage.record({ account: account.uin, model, promptChars: promptChars || prompt, completionChars: content.length, ok: true });

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

export function createApp(pool, logins = new LoginManager(pool), usage = new UsageStore(USAGE_FILE), config = new ConfigStore(CONFIG_FILE)) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/index.html")) {
        return await sendWebIndex(response);
      }
      if (request.method === "GET" && url.pathname === "/auth/status") {
        return sendJson(response, 200, {
          mode: config.mode,
          adminRequired: config.requiresAdminKey(),
          authorized: config.verifyAdmin(adminKeyOf(request)),
        });
      }
      if (request.method === "POST" && url.pathname === "/auth/login") {
        const body = await readBody(request);
        const ok = config.verifyAdmin(String(body.key || ""));
        return sendJson(response, ok ? 200 : 401, ok ? { ok: true, mode: config.mode } : { error: { message: "admin key 不正确", type: "auth_error" } });
      }
      if (isAdminPath(url.pathname) && !config.verifyAdmin(adminKeyOf(request))) {
        return sendJson(response, 401, {
          error: {
            message: config.requiresAdminKey() ? "需要 admin key" : "拒绝访问",
            type: "auth_error",
            code: "admin_key_required",
          },
        });
      }
      if (isApiPath(url.pathname) && !config.verifyApiKey(apiKeyOf(request))) {
        return sendJson(response, 401, {
          error: { message: "缺少或无效的 API key", type: "invalid_request_error", code: "invalid_api_key" },
        });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        let browser = null;
        try { browser = findBrowser(); } catch { /* 没有可用浏览器 */ }
        return sendJson(response, 200, {
          ok: true,
          mode: config.mode,
          accounts: pool.list().length,
          browser,
          logins: logins.active().length,
        });
      }
      if (url.pathname === "/config" && request.method === "GET") {
        return sendJson(response, 200, config.snapshot());
      }
      if (url.pathname === "/config/keys" && request.method === "POST") {
        const body = await readBody(request);
        const created = await config.addKey(body.name);
        return sendJson(response, 201, { id: created.id, name: created.name, key: created.key });
      }
      if (url.pathname.startsWith("/config/keys/")) {
        const id = decodeURIComponent(url.pathname.slice("/config/keys/".length));
        if (request.method === "PATCH") {
          const body = await readBody(request);
          const ok = await config.setDisabled(id, body.disabled !== false);
          return sendJson(response, ok ? 200 : 404, { updated: ok });
        }
        if (request.method === "DELETE") {
          const removed = await config.removeKey(id);
          return sendJson(response, removed ? 200 : 404, { removed });
        }
        return sendJson(response, 405, { error: { message: "不支持的方法" } });
      }
      if (request.method === "POST" && url.pathname === "/login") {
        const body = await readBody(request);
        const mode = ["auto", "attach", "launch"].includes(body.mode) ? body.mode : "auto";
        const job = logins.start({
          url: body.url,
          mode,
          profile: body.profile,
          fresh: body.fresh !== false,
          timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined,
        });
        return sendJson(response, 202, job);
      }
      if (request.method === "GET" && url.pathname === "/login") {
        return sendJson(response, 200, { jobs: logins.active() });
      }
      if (url.pathname.startsWith("/login/")) {
        const id = decodeURIComponent(url.pathname.slice("/login/".length));
        if (request.method === "GET") {
          const job = logins.get(id);
          return job ? sendJson(response, 200, job) : sendJson(response, 404, { error: { message: "没有这个登录任务" } });
        }
        if (request.method === "DELETE") {
          const cancelled = logins.cancel(id);
          return sendJson(response, cancelled ? 200 : 404, { cancelled });
        }
        return sendJson(response, 405, { error: { message: "不支持的方法" } });
      }
      if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return sendJson(response, 200, { object: "list", data: MODELS.map((model) => ({ ...model, object: "model" })) });
      }
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
        if (request.method !== "POST") return sendJson(response, 405, { error: { message: "只接受 POST" } });
        return await handleChat(request, response, pool, usage);
      }
      if (request.method === "GET" && url.pathname === "/usage") {
        return sendJson(response, 200, usage.snapshot());
      }
      if (request.method === "POST" && url.pathname === "/models/probe") {
        const body = await readBody(request);
        const account = pool.next();
        const wanted = Array.isArray(body.models) && body.models.length ? body.models : MODELS.map((item) => item.id);
        const results = [];
        for (const model of wanted) {
          const result = await probeModel(account, String(model));
          usage.record({ account: account.uin, model: String(model), promptChars: 3, ok: result.ok, error: result.error });
          results.push(result);
        }
        return sendJson(response, 200, { account: account.uin, results });
      }
      if (url.pathname === "/accounts" || url.pathname.startsWith("/accounts/")) {
        return await handleAccounts(request, response, pool, url);
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
  const usage = new UsageStore(USAGE_FILE);
  await usage.load();
  const config = new ConfigStore(CONFIG_FILE);
  await config.load();
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({ accounts: pool.list().length, models: MODELS.length, mode: config.mode }));
  } else {
    const server = createApp(pool, new LoginManager(pool), usage, config);
    server.on("error", (error) => {
      console.error(`proxy failed: ${error.message}`);
      process.exit(1);
    });
    server.listen(PORT, HOST, () => {
      console.log(`OrcaTerm proxy listening on http://${HOST}:${PORT}`);
      console.log(`accounts: ${pool.list().length}`);
      console.log(`mode: ${config.mode}${config.requiresAdminKey() ? "（控制台需要 admin key）" : "（仅本机可用，无需 admin key）"}`);
      if (config.generatedAdminKey) console.log(`已生成 admin key：${config.adminKey}   （保存在 ${config.path()}）`);
      if (config.generatedApiKey) console.log(`已生成 API key：${config.apiKeys[0].key}`);
      console.log(`config: ${config.path()}`);
    });
  }
}
