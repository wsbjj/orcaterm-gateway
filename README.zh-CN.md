<div align="center">

# 中文

**一个本地 OpenAI 兼容入口，轮询多个 OrcaTerm 账号**

[English](README.md)

</div>

把腾讯云 OrcaTerm 内置的 LightAI 助手接到任何支持 OpenAI Chat Completions API 的客户端。一个本地地址可以轮流使用多个你自己控制的账号。

```text
OpenAI 客户端  ->  localhost:8787  ->  账号池  ->  LightAI
```

> 只能使用你自己控制的账号。代理不会注册账号、获取凭证，也不会绕过腾讯云登录校验。

## 为什么需要它

| 直接使用 OrcaTerm | 这个代理 |
| --- | --- |
| 绑在一个浏览器会话里 | 可接入 OpenAI SDK 和现有工具 |
| 一次手动使用一个账号 | 本地账号池轮询 |
| 返回 OrcaTerm 任务 JSON | 返回可见回答，并标出工具请求 |
| 手工处理 Cookie | 支持 Cookie、JSON、Netscape 和文本行 |

## 特性

- 兼容 OpenAI 的 `POST /v1/chat/completions`，支持 JSON 和 SSE。
- 本地多账号池，按 UIN 覆盖，并按顺序轮询。
- 支持 Cookie 字符串、浏览器 Cookie JSON、Netscape `cookies.txt` 和一行一个账号。
- `system` 与 `developer` 指令按高优先级转发，也可用 `INJECT_SYSTEM` 追加全局指令。
- 上游任务 JSON 会收成可见回答。
- 工具调用只转成可读文本，代理不会执行工具。
- 空响应和网关错误最多自动重试三次。

## 快速开始

需要 Node.js 22 或更新版本。

```bash
git clone https://github.com/Huang-404-Q/orcaterm-proxy.git
cd orcaterm-proxy
npm start
```

代理默认监听 [http://127.0.0.1:8787](http://127.0.0.1:8787)。用浏览器打开同一地址即可进入内置 Web 控制台（账号池、模型与对话测试）。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `ACCOUNTS_FILE` | `data/accounts.json` | 本地账号文件 |
| `INJECT_SYSTEM` | 空 | 加到高优先级指令前面的文本 |

Windows 可以直接运行带默认人设覆盖的脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File start-proxy.ps1
```

## 导入账号

账号需要 `uin`，以及 `skey` 或 `p_skey`。这些值来自一个已经可以打开 OrcaTerm 的腾讯云会话。

```bash
curl -X POST http://127.0.0.1:8787/accounts \
  -H "content-type: application/json" \
  -d '{"accounts":[{"cookie":"uin=o123456789; skey=YOUR_SKEY; p_skey=YOUR_P_SKEY"}]}'
```

| 格式 | 示例 |
| --- | --- |
| Cookie 请求头 | `uin=o123; skey=...; p_skey=...` |
| 浏览器 Cookie JSON | `[{"domain":".tencent.com","name":"uin","value":"o123"}]` |
| Netscape 文件 | `npm run import -- cookies.txt` |
| 文本行 | `123 YOUR_SKEY YOUR_P_SKEY` |

`POST /accounts` 按 UIN 新增或更新，`PUT /accounts` 替换整个池，`GET /accounts` 只返回编号和状态，`DELETE /accounts/<uin>` 删除一个账号。`data/` 不会进入 Git。

## 调用

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"kimi-latest","messages":[{"role":"user","content":"写一个统计 JavaScript 文件数量的函数。"}]}'
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local",
  baseURL: "http://127.0.0.1:8787/v1",
});

const result = await client.chat.completions.create({
  model: "kimi-latest",
  messages: [{ role: "user", content: "你好" }],
});
```

所选上游账号必须有该模型的使用权限。`GET /v1/models` 返回这个代理认识的模型标识。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 检查进程和账号数量 |
| `GET` | `/v1/models` | 已知模型标识 |
| `POST` | `/v1/chat/completions` | OpenAI 兼容聊天请求 |
| `GET` | `/accounts` | 脱敏后的账号列表 |
| `POST` | `/accounts` | 新增或更新账号 |
| `PUT` | `/accounts` | 替换全部账号 |
| `DELETE` | `/accounts/:uin` | 删除一个账号 |

机器可读描述位于 [openapi.json](openapi.json)。

## 请求流程

1. OpenAI 消息被分成高优先级指令和用户输入。
2. 选择下一个可用账号，并计算腾讯云 CSRF 值。
3. 代理携带该账号的 Cookie 调用 LightAI 聊天接口。
4. 增量 SSE 内容被组装起来。
5. 完成 JSON 收成可见回答；工具审查动作收成 `[模型请求执行工具 ...]`。
6. 结果按 JSON 或 OpenAI 兼容 SSE 返回。

## 限制

- 上游会话状态仍属于被选中的账号。本地历史会作为一次新请求发送。
- 模型可用性、额度和账号校验由上游决定。
- 代理不会执行模型请求的工具，只会把请求显示出来。
- 人设覆盖会被转发，但模型仍可能不遵守；与指定身份冲突的默认身份回复会自动重试。

## 开发

```bash
npm test
```

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，使用 [MIT](LICENSE) 许可证。
