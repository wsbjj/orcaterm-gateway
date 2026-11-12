<div align="center">

# OrcaTerm Proxy

**One local OpenAI-compatible endpoint for multiple OrcaTerm accounts**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-node%3Atest-black.svg)](test/proxy.test.js)
[![API](https://img.shields.io/badge/API-OpenAI%20compatible-412991.svg)](openapi.json)

English · [中文](README.zh-CN.md)

![Web console](docs/console.png)

</div>

Bring the LightAI assistant inside Tencent Cloud OrcaTerm to any client that speaks the OpenAI Chat Completions API. Add more accounts when you need more capacity, then keep calling one local URL.

```text
OpenAI client  ->  localhost:8787  ->  account pool  ->  LightAI
```

> Use this with accounts you control. The proxy does not create accounts, recover credentials, or bypass Tencent Cloud authentication.

## Changes in this branch

Everything below was added or fixed on top of the original proxy. The point of the branch is: **you should never have to copy a cookie by hand**, and **failures should tell you what actually broke**.

### Browser login (new)

A one-click login flow that drives a real browser and captures the session itself.

| File | What it does |
| --- | --- |
| `src/browser.js` | Finds Chrome / Edge / Chromium / Brave per platform (`CHROME_PATH` overrides). Speaks CDP over Node's native WebSocket client with a timeout on every command. Reads cookies through four fallbacks, caching whichever one works: page-level `Network.getCookies` → browser-level `Storage.getCookies` → page-level `Storage.getCookies` → browser-level `Network.getAllCookies`. |
| `src/login.js` | `LoginManager`: three modes, a throwaway profile per launch, job state polling, transient-failure tolerance, and lifecycle logging (`[login:xxxxxxxx] …` on stdout). De-duplicates same-name cookies by domain precision, so `.cloud.tencent.com` wins over a stale `.tencent.com` copy. |
| `src/open-login.js` | `npm run login` rewritten. The old version hard-coded `D:\workplace\…\chrome.exe` and never actually read a cookie. |

Three modes, selectable in the console or via `--attach` / `--launch`:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Try a new tab in your current browser; fall back to a dedicated window |
| `attach` | Current browser only; fail with instructions if it is not reachable |
| `launch` | Always launch a dedicated instance with a temporary profile |

`attach` mode works two ways: the classic `--remote-debugging-port`, or — since that flag is **silently ignored for the default profile on Chrome 136+** — the `chrome://inspect/#remote-debugging` toggle, whose random port is discovered by reading `DevToolsActivePort` from the browser's User Data directory. In `attach` mode the proxy opens one tab, reads cookies, and closes only that tab; your browser stays untouched. In `launch` mode it uses a throwaway profile, so your daily session is never involved.

New endpoints: `POST /login`, `GET /login`, `GET /login/:id`, `DELETE /login/:id`. `GET /health` now also reports the detected browser path.

### Usage accounting and model permissions (new)

The upstream exposes **no quota, balance, or usage API** — `/assistant/quota`, `/assistant/usage`, `/assistant/balance`, `/assistant/user`, `/assistant/models`, `/assistant/config` and `/assistant/stream/status` all return `code: 404`. So accounting is local instead.

| File | What it does |
| --- | --- |
| `src/usage.js` | `UsageStore`: requests, failures, and character counts grouped by total / model / account / day, persisted to `data/usage.json` with a 1 s write debounce. |
| `src/probe.js` | `probeModel`: sends one minimal request per model to learn whether the account is authorized for it. |

New endpoints: `GET /usage`, `POST /models/probe`.

### Access control: admin key and API key (new)

Two keys, two jobs:

| Key | Guards | Required when | Default |
| --- | --- | --- | --- |
| **admin key** | The console page and every management endpoint | `remote` mode only | Generated on first start in remote mode, written to `data/config.json`, printed to the startup log |
| **API key** | All `/v1/*` calls | Both modes | Generated on first start |

`data/config.json`:

```json
{
  "mode": "local",
  "adminKey": "",
  "apiKeys": [
    { "id": "…", "name": "default", "key": "sk-orca-…", "disabled": false }
  ]
}
```

- `local` — for this machine only; the console needs no admin key.
- `remote` — for exposing the proxy to other machines. Leave `adminKey` empty and one is generated at startup; the console then shows a login gate that requires it. Override with `ORCA_ADMIN_KEY`, or force the mode with `ORCA_MODE=remote`.
- Management endpoints (`/accounts`, `/login`, `/usage`, `/models/probe`, `/config`) require the admin key in remote mode and are open in local mode.
- API keys are managed in the console's "访问密钥" section: create, disable, delete, reveal, copy. Send them as `Authorization: Bearer <key>` or `x-api-key`.
- The section also shows the current **base URL**, derived from however you reached the console — `127.0.0.1`, a LAN IP, or a reverse-proxied domain. One click copies it as the OpenAI SDK `baseURL`.

> Lost the admin key? Read `adminKey` from `data/config.json`.

### Bugs fixed

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every upstream failure showed as `上游返回空内容` | Upstream reports errors as a **plain-text** SSE frame (`data: [ERROR]: [LLM_ERROR]: 401 …`). `parseSseBlock` returned `null`, and the frame was skipped. | `sseErrorMessage()` surfaces the text; such errors are marked `noRetry` instead of being retried three times. |
| Account stopped working after a proxy restart | `pool.save()` wrote only `id/uin/skey/p_skey`, dropping `qcmainCSRFToken`, `qcloud_uid`, `language`. | `extraCookies` are persisted and re-parsed on load. |
| `DELETE /accounts/o<uin>` returned 404 | UINs are normalized (leading `o` stripped), so the stored id never matched the documented path. | `pool.remove()` matches id, raw uin, and normalized uin. |
| Malformed account input returned 500 | Parse errors never set a status. | Parse failures (including invalid JSON) now return 400. |
| `GET /upstream/status` always failed | It called `/assistant/stream/status`, which does not exist upstream. | Route removed. |
| Hidden console sections were visible | `.login { display: flex }` overrode the `hidden` attribute. | `[hidden] { display: none !important }`. |

Tests went from 4 to 10.

### What the upstream actually requires

Verified against a live account, not assumed:

- **`p_skey` is not needed.** Tencent Cloud no longer issues it. The session is `uin` + `skey` on `.cloud.tencent.com`, plus `qcmainCSRFToken`, `qcloud_uid`, and `language`. A full browser cookie dump contains no `p_skey` at all. `skey` alone is sufficient; `p_skey` is used if present.
- **Model permissions are per account.** The same account returns `401 token无访问此模型权限` for `hy3` and `hunyuan-lite`, while `hunyuan-turbos`, `deepseek-chat`, `glm-4.7`, and `qwen3` work. Use the console's "探测模型权限" button to map your own account.
- **OAuth authorize links cannot be hand-crafted.** `state` is server-issued and single-use; a stale or self-generated one ends on `{"code":"STATE_EXPIRED"}`. The default login target is the OrcaTerm terminal page so the app starts the flow itself.

## Why this exists

| Direct OrcaTerm session | This proxy |
| --- | --- |
| Works inside one browser session | Works with OpenAI SDKs and existing tools |
| One account at a time | Round-robin across a local account pool |
| OrcaTerm task JSON in responses | Visible answer text, with tool requests labeled |
| Manual cookie handling | One-click browser login, plus four import formats |

## Features

- OpenAI-compatible `POST /v1/chat/completions`, including JSON and SSE responses.
- One-click browser login with automatic cookie capture.
- Local multi-account pool with round-robin selection and same-UIN replacement.
- Cookie header, browser cookie JSON, Netscape `cookies.txt`, and line-based import.
- `system` and `developer` instructions are forwarded with priority, with optional `INJECT_SYSTEM`.
- Upstream task JSON is reduced to its visible answer; upstream text errors are surfaced verbatim.
- Local usage accounting and per-model permission probing.
- Empty responses and gateway failures retry up to three times; deterministic failures do not.

## Quick start

Requires Node.js 22 or newer.

```bash
git clone https://github.com/Huang-404-Q/orcaterm-proxy.git
cd orcaterm-proxy
npm start
```

The proxy listens on [http://127.0.0.1:8787](http://127.0.0.1:8787). Open the same address for the web console.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | Bind port |
| `ACCOUNTS_FILE` | `data/accounts.json` | Local account store |
| `USAGE_FILE` | `data/usage.json` | Local usage counters |
| `CONFIG_FILE` | `data/config.json` | Mode, admin key, API keys |
| `ORCA_MODE` | from config | Override mode: `local` / `remote` |
| `ORCA_ADMIN_KEY` | from config | Pin the admin key instead of generating one |
| `INJECT_SYSTEM` | empty | Text prepended to priority instructions |
| `CHROME_PATH` | auto-detected | Chrome / Edge / Chromium executable |
| `CHROME_DEBUG_URL` | `http://127.0.0.1:9222` | Extra debug endpoint to try in attach mode |

## Add your account

### Browser login (recommended)

```bash
npm run login               # auto mode
npm run login -- --attach   # current browser tab only
```

To use your **current browser** — the only mode that reuses an existing session, so you may not have to log in at all:

1. Open `chrome://inspect/#remote-debugging` in Chrome or Edge 144+.
2. Enable remote debugging and accept the prompt.
3. Press "打开登录" in the console.

The proxy reads `DevToolsActivePort` from the browser's User Data directory, connects to the random port over the browser-level WebSocket, and opens a new tab with `Target.createTarget`.

> ⚠️ While the debugging toggle is on, local programs can read that browser's cookies. Turn it off when you are done. Cookies are encrypted at rest with App-Bound Encryption and are readable only by the browser itself, which is why CDP is the only workable automation path.

If the toggle is unavailable, the proxy falls back to a dedicated window with a throwaway profile, where you log in normally. The window closes itself once the account is captured.

### Manual import

An account needs `uin` and `skey`.

```bash
curl -X POST http://127.0.0.1:8787/accounts \
  -H "content-type: application/json" \
  -d '{"accounts":[{"cookie":"uin=o123456789; skey=YOUR_SKEY"}]}'
```

| Input | Example |
| --- | --- |
| Cookie header | `uin=o123; skey=...; qcmainCSRFToken=...` |
| Browser cookie JSON | `[{"domain":".cloud.tencent.com","name":"uin","value":"o123"}]` |
| Netscape file | `npm run import -- cookies.txt` |
| Line format | `123 YOUR_SKEY` |

In `remote` mode add `-H "Authorization: Bearer <admin key>"` to the curl above.

`POST /accounts` adds or updates by UIN. `PUT /accounts` replaces the pool. `GET /accounts` returns identifiers and health only. `DELETE /accounts/<uin>` removes one account (`o` prefix optional). The `data/` directory is gitignored.

## Use it

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -H "Authorization: Bearer sk-orca-YOUR_KEY" \
  -d '{"model":"hunyuan-turbos","messages":[{"role":"user","content":"Write a function that counts JavaScript files."}]}'
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-orca-YOUR_KEY",
  baseURL: "http://127.0.0.1:8787/v1",
});

const result = await client.chat.completions.create({
  model: "hunyuan-turbos",
  messages: [{ role: "user", content: "Hello" }],
});
```

The model must be enabled for the selected upstream account. `GET /v1/models` lists the identifiers known to this proxy; `POST /models/probe` tells you which of them actually work.

Every `/v1/*` request needs the API key (`Authorization: Bearer <key>` or `x-api-key`); without it you get 401 `缺少或无效的 API key`. Copy the key from the console's "访问密钥" section.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Process, mode, account count, browser, active logins |
| `GET` | `/auth/status` | Mode, whether an admin key is required, whether this request is authorized |
| `POST` | `/auth/login` | Verify the admin key |
| `GET` | `/config` | Mode and API keys (admin only) |
| `POST` | `/config/keys` | Create an API key |
| `PATCH` | `/config/keys/:id` | Disable or enable an API key |
| `DELETE` | `/config/keys/:id` | Delete an API key |
| `GET` | `/v1/models` | Known model identifiers |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat request |
| `POST` | `/login` | Open a browser login, returns a job id |
| `GET` | `/login` | Active login jobs |
| `GET` | `/login/:id` | Poll a login job |
| `DELETE` | `/login/:id` | Cancel a login and close the tab/window |
| `GET` | `/usage` | Local usage stats and model availability |
| `POST` | `/models/probe` | Probe per-model permissions |
| `GET` | `/accounts` | Sanitized account list |
| `POST` | `/accounts` | Add or update accounts |
| `PUT` | `/accounts` | Replace all accounts |
| `DELETE` | `/accounts/:uin` | Remove one account |

The machine-readable description is in [openapi.json](openapi.json).

## How a request moves

1. The OpenAI-style message list is split into priority instructions and user input.
2. The next enabled account is selected and its Tencent Cloud CSRF value is calculated from `skey`.
3. The proxy calls the LightAI chat endpoint with that account's cookie.
4. Incremental SSE content is assembled; plain-text `[ERROR]` frames abort with the upstream message.
5. Completion JSON becomes the visible answer. A review action becomes `[模型请求执行工具 ...]`.
6. The result is returned as JSON or OpenAI-compatible SSE, and the request is counted locally.

## Limitations

- Upstream conversation state remains tied to the selected account. Local history is sent as a new request.
- Model availability, quota, and account enforcement are controlled upstream and cannot be queried; only local accounting is available.
- The proxy never executes a requested tool. It only reports the request.
- A persona override is forwarded, but a model can still fail to follow it; conflicting default-identity replies are retried.

## Development

```bash
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
