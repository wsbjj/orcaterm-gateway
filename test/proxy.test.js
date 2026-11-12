import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { csrfCode, parseAccounts } from "../src/accounts.js";
import { ConfigStore, maskKey } from "../src/config.js";
import { createApp } from "../src/server.js";
import { buildCookieString, cookieState, domainMatches } from "../src/login.js";
import { emphasisPrompt, sseErrorMessage, toLightAiInput, visibleText } from "../src/openai.js";
import { AccountPool } from "../src/pool.js";
import { UsageStore } from "../src/usage.js";

test("calculates the Tencent Cloud CSRF hash", () => {
  assert.match(csrfCode("@abc"), /^[0-9]+$/);
  assert.equal(csrfCode(""), "");
});

test("imports cookie, JSON, and Netscape account formats", () => {
  const [cookie] = parseAccounts("uin=o123; skey=one; p_skey=two");
  assert.equal(cookie.uin, "123");
  assert.equal(cookie.skey, "one");
  assert.equal(cookie.pSkey, "two");

  const [exported] = parseAccounts(JSON.stringify([
    { domain: ".tencent.com", name: "uin", value: "o456" },
    { domain: ".cloud.tencent.com", name: "p_skey", value: "abc%3D" },
    { domain: "example.com", name: "noise", value: "ignore" },
  ]));
  assert.equal(exported.uin, "456");
  assert.equal(exported.pSkey, "abc=");

  const [netscape] = parseAccounts("# Netscape HTTP Cookie File\n.tencent.com\tTRUE\t/\tTRUE\t0\tuin\to789\n.cloud.tencent.com\tTRUE\t/\tTRUE\t0\tskey\thello");
  assert.equal(netscape.uin, "789");
  assert.equal(netscape.skey, "hello");
});

test("places system instructions ahead of the user input", () => {
  const body = {
    messages: [
      { role: "system", content: "你是通用助手小助。" },
      { role: "user", content: "写一个函数。" },
    ],
  };
  assert.equal(emphasisPrompt(body), "你是通用助手小助。");
  assert.match(toLightAiInput(body), /^以下身份和规则优先于你的默认身份/);
  assert.match(toLightAiInput(body), /写一个函数。$/);
});

test("extracts visible assistant text and tool requests", () => {
  assert.equal(visibleText({ action: "completion", taskCompletion: "成功" }), "成功");
  assert.match(visibleText({ action: "review", tool: { mcpServer: "terminal", name: "run", arguments: { command: "pwd" } } }), /^\[模型请求执行工具 terminal\/run\]/);
});

test("matches only cookies that apply to the upstream host", () => {
  assert.ok(domainMatches(".cloud.tencent.com"));
  assert.ok(domainMatches("lightai.cloud.tencent.com"));
  assert.ok(domainMatches(".tencent.com"));
  assert.ok(!domainMatches(".qq.com"));
  assert.ok(!domainMatches("example.com"));
  assert.ok(!domainMatches(""));

  const cookies = [
    { name: "uin", value: "o123", domain: ".qq.com" },
    { name: "uin", value: "o123", domain: ".tencent.com" },
    { name: "p_skey", value: "WRONG", domain: ".qq.com" },
    { name: "p_skey", value: "CLOUD", domain: ".cloud.tencent.com" },
    { name: "skey", value: "S", domain: ".tencent.com" },
    { name: "noise", value: "x", domain: "example.com" },
  ];
  const cookie = buildCookieString(cookies);
  assert.match(cookie, /p_skey=CLOUD/);
  assert.doesNotMatch(cookie, /WRONG/);
  assert.doesNotMatch(cookie, /noise/);
  const state = cookieState(cookies);
  assert.deepEqual([state.hasUin, state.hasSkey, state.hasPSkey], [true, true, true]);
  assert.equal(state.names.includes("noise"), false);
});

test("removes an account by uin with or without the o prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orcaterm-test-"));
  try {
    const pool = new AccountPool(join(dir, "accounts.json"));
    await pool.add("uin=o1001; skey=a; p_skey=b");
    assert.equal(pool.list().length, 1);
    assert.equal(await pool.remove("o1001"), true);
    assert.equal(pool.list().length, 0);
    assert.equal(await pool.remove("o1001"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects malformed account input with a 400", () => {
  assert.throws(() => parseAccounts('{"accounts":[{"skey":"x"}]}'), (error) => error.status === 400);
  assert.throws(() => parseAccounts("[{broken"), (error) => error.status === 400);
});

test("surfaces upstream text errors instead of dropping them", () => {
  const block = "data: [ERROR]: [LLM_ERROR]: 401 token无访问此模型权限  Troubleshooting URL: https://js.langchain.com/docs/troubleshooting/errors/MODEL_AUTHENTICATION/";
  assert.equal(sseErrorMessage(block), "401 token无访问此模型权限");
  assert.equal(sseErrorMessage('data: {"content":"hi"}'), "");
  assert.equal(sseErrorMessage("event: ping"), "");
});

test("records local usage per model and day", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orcaterm-usage-"));
  try {
    const store = new UsageStore(join(dir, "usage.json"));
    await store.load();
    store.record({ account: "1", model: "m", promptChars: 10, completionChars: 5, ok: true });
    store.record({ account: "1", model: "m", promptChars: 4, ok: false, error: "401 no" });
    const snapshot = store.snapshot();
    assert.equal(snapshot.total.requests, 2);
    assert.equal(snapshot.total.errors, 1);
    assert.equal(snapshot.today.requests, 2);
    assert.equal(snapshot.byModel.m.requests, 2);
    assert.equal(snapshot.models.m.fail, 1);
    assert.match(snapshot.models.m.lastError, /401/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps extra cookies such as qcmainCSRFToken across a save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orcaterm-extras-"));
  try {
    const file = join(dir, "accounts.json");
    const pool = new AccountPool(file);
    await pool.add("uin=o2002; skey=k; qcmainCSRFToken=t; qcloud_uid=u");
    const reloaded = new AccountPool(file);
    await reloaded.load();
    const [account] = reloaded.list();
    assert.equal(account.uin, "2002");
    const again = await reloaded.add("uin=o2002; skey=k");
    assert.equal(again.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generates an api key on first run and only requires an admin key in remote mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orcaterm-config-"));
  try {
    const file = join(dir, "config.json");
    const local = new ConfigStore(file);
    await local.load();
    assert.equal(local.mode, "local");
    assert.equal(local.requiresAdminKey(), false);
    assert.equal(local.apiKeys.length, 1);
    assert.match(local.apiKeys[0].key, /^sk-orca-[a-z0-9]{40}$/);
    assert.equal(local.verifyApiKey("sk-orca-nope"), null);
    assert.ok(local.verifyApiKey(local.apiKeys[0].key));

    const remote = new ConfigStore(file);
    await remote.load();
    assert.equal(remote.mode, "local");

    const parsed = JSON.parse(await readFile(file, "utf8"));
    parsed.mode = "remote";
    parsed.adminKey = "";
    await writeFile(file, JSON.stringify(parsed), "utf8");

    const switched = new ConfigStore(file);
    await switched.load();
    assert.equal(switched.mode, "remote");
    assert.equal(switched.requiresAdminKey(), true);
    assert.match(switched.adminKey, /^adm-[a-z0-9]{40}$/);
    assert.equal(switched.generatedAdminKey, true);
    assert.equal(switched.verifyAdmin("adm-wrong"), false);
    assert.equal(switched.verifyAdmin(switched.adminKey), true);

    const created = await switched.addKey("ci");
    assert.equal(switched.apiKeys.length, 2);
    assert.ok(switched.verifyApiKey(created.key));
    assert.equal(await switched.setDisabled(created.id, true), true);
    assert.equal(switched.verifyApiKey(created.key), null);
    assert.equal(await switched.removeKey(created.id), true);
    assert.equal(switched.apiKeys.length, 1);

    assert.equal(maskKey("sk-orca-abcdefghijklmnop"), "sk-orca-…mnop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guards the console behind the admin key and /v1 behind the api key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orcaterm-auth-"));
  const config = new ConfigStore(join(dir, "config.json"));
  await config.load();
  config.mode = "remote";
  config.adminKey = "adm-test-key";
  await config.save();
  const pool = new AccountPool(join(dir, "accounts.json"));
  await pool.load();
  const usage = new UsageStore(join(dir, "usage.json"));
  await usage.load();
  const app = createApp(pool, undefined, usage, config);
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const apiKey = config.apiKeys[0].key;
  try {
    assert.equal((await fetch(`${base}/accounts`)).status, 401);
    assert.equal((await fetch(`${base}/accounts`, { headers: { Authorization: "Bearer adm-wrong" } })).status, 401);
    assert.equal((await fetch(`${base}/accounts`, { headers: { Authorization: "Bearer adm-test-key" } })).status, 200);

    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer sk-orca-nope" } })).status, 401);
    assert.equal((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } })).status, 200);
    assert.equal((await fetch(`${base}/v1/models`, { headers: { "x-api-key": apiKey } })).status, 200);

    const status = await (await fetch(`${base}/auth/status`)).json();
    assert.equal(status.adminRequired, true);
    assert.equal(status.authorized, false);

    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "adm-test-key" }),
    });
    assert.equal(login.status, 200);

    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
