<div align="center">

# OrcaTerm Proxy

**One local OpenAI-compatible endpoint for multiple OrcaTerm accounts**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-node%3Atest-black.svg)](test/proxy.test.js)
[![API](https://img.shields.io/badge/API-OpenAI%20compatible-412991.svg)](openapi.json)

English · [中文](README.zh-CN.md)

</div>

Bring the LightAI assistant inside Tencent Cloud OrcaTerm to any client that speaks the OpenAI Chat Completions API. Add more accounts when you need more capacity, then keep calling one local URL.

```text
OpenAI client  ->  localhost:8787  ->  account pool  ->  LightAI
```

> Use this with accounts you control. The proxy does not create accounts, recover credentials, or bypass Tencent Cloud authentication.

## Why this exists

| Direct OrcaTerm session | This proxy |
| --- | --- |
| Works inside one browser session | Works with OpenAI SDKs and existing tools |
| One account at a time | Round-robin across a local account pool |
| OrcaTerm task JSON in responses | Visible answer text, with tool requests labeled |
| Manual cookie handling | Cookie, JSON, Netscape, and line import formats |

## Features

- OpenAI-compatible `POST /v1/chat/completions`, including JSON and SSE responses.
- Local multi-account pool with round-robin selection and same-UIN replacement.
- Cookie header, browser cookie JSON, Netscape `cookies.txt`, and line-based import.
- `system` and `developer` instructions are forwarded with priority, with optional `INJECT_SYSTEM`.
- Upstream task JSON is reduced to its visible answer.
- Tool-review actions become readable text; no tool is executed by the proxy.
- Empty responses and gateway failures retry up to three times.

## Quick start

Requires Node.js 22 or newer.

```bash
git clone https://github.com/Huang-404-Q/orcaterm-proxy.git
cd orcaterm-proxy
npm start
```

The proxy listens on [http://127.0.0.1:8787](http://127.0.0.1:8787). Open the same address in a browser for the built-in web console (account pool, models, and a test chat).

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | Bind port |
| `ACCOUNTS_FILE` | `data/accounts.json` | Local account store |
| `INJECT_SYSTEM` | empty | Text prepended to priority instructions |

On Windows, the included script sets a default persona override:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File start-proxy.ps1
```

## Add your account

An account needs `uin` and either `skey` or `p_skey` from a Tencent Cloud session that can already open OrcaTerm.

```bash
curl -X POST http://127.0.0.1:8787/accounts \
  -H "content-type: application/json" \
  -d '{"accounts":[{"cookie":"uin=o123456789; skey=YOUR_SKEY; p_skey=YOUR_P_SKEY"}]}'
```

| Input | Example |
| --- | --- |
| Cookie header | `uin=o123; skey=...; p_skey=...` |
| Browser cookie JSON | `[{"domain":".tencent.com","name":"uin","value":"o123"}]` |
| Netscape file | `npm run import -- cookies.txt` |
| Line format | `123 YOUR_SKEY YOUR_P_SKEY` |

`POST /accounts` adds or updates by UIN. `PUT /accounts` replaces the pool. `GET /accounts` returns identifiers and health only. `DELETE /accounts/<uin>` removes one account. The `data/` directory is gitignored.

## Use it

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"kimi-latest","messages":[{"role":"user","content":"Write a function that counts JavaScript files."}]}'
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local",
  baseURL: "http://127.0.0.1:8787/v1",
});

const result = await client.chat.completions.create({
  model: "kimi-latest",
  messages: [{ role: "user", content: "Hello" }],
});
```

The model must be enabled for the selected upstream account. `GET /v1/models` returns the identifiers known to this proxy.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Process and account-count check |
| `GET` | `/v1/models` | Known model identifiers |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat request |
| `GET` | `/accounts` | Sanitized account list |
| `POST` | `/accounts` | Add or update accounts |
| `PUT` | `/accounts` | Replace all accounts |
| `DELETE` | `/accounts/:uin` | Remove one account |

The machine-readable description is in [openapi.json](openapi.json).

## How a request moves

1. The OpenAI-style message list is split into priority instructions and user input.
2. The next enabled account is selected and its Tencent Cloud CSRF value is calculated.
3. The proxy calls the LightAI chat endpoint with that account's cookie.
4. Incremental SSE content is assembled.
5. Completion JSON becomes the visible answer. A review action becomes `[模型请求执行工具 ...]`.
6. The result is returned as JSON or OpenAI-compatible SSE.

## Limitations

- Upstream conversation state remains tied to the selected account. Local history is sent as a new request.
- Model availability, quota, and account enforcement are controlled upstream.
- The proxy never executes a requested tool. It only reports the request.
- A persona override is forwarded, but a model can still fail to follow it; conflicting default-identity replies are retried.

## Development

```bash
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
