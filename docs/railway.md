# 部署到 Railway

`dev-railway` 分支专门干这件事：把代理塞进容器，跑在 Railway 上，给任何能连公网的 OpenAI 客户端用。

跟本地跑的区别只有三点：**绑 `0.0.0.0`**（`Dockerfile` 里已设）、**账号只能靠环境变量或接口导入**（容器里没浏览器）、**数据必须落在一个 Volume 上**（否则每次重新部署就清空）。

## 1. 推仓库

Railway 从 GitHub 拉代码。先把分支推上去：

```bash
git push -u origin dev-railway
```

## 2. 建项目

1. Railway 控制台 → **New Project** → **Deploy from GitHub repo** → 选这个仓库。
2. 进服务 → **Settings** → **Source** → Branch 改成 `dev-railway`。
3. 构建方式不用改：仓库根目录有 `Dockerfile`，Railway 会自动用，`railway.json` 里也写死了 `builder: DOCKERFILE`。

## 3. 挂 Volume（必做）

服务页 → **+ New** → **Volume** → **Mount path** 填 `/data` → 保存。

不挂也能跑，但每次重新部署 `/data/*.json` 全部重来：账号没了、API key 换了、用量清零。

## 4. 配变量

服务页 → **Variables** → **Raw Editor**，粘这些（模板见仓库里的 `.env.example`）：

```env
ORCA_ADMIN_KEY=adm-自己编一个长随机串
ORCA_API_KEY=sk-orca-自己编一个长随机串
ORCA_ACCOUNTS=uin=o123456789; skey=YOUR_SKEY; p_skey=YOUR_PSKEY
INJECT_SYSTEM=
```

| 变量 | 为什么要在 Railway 上设 |
| --- | --- |
| `ORCA_ADMIN_KEY` | 不设就每次部署随机生成一个，只能去 Deploy Logs 里翻 `已生成 admin key：…` |
| `ORCA_API_KEY` | 不设且没挂卷，`/v1/*` 的 key 每次部署都变，客户端得跟着改。多个用逗号分隔 |
| `ORCA_ACCOUNTS` | 容器里没有浏览器，账号只能这样喂。只在账号池为空时导入，不会覆盖控制台里手改的账号 |
| `INJECT_SYSTEM` | 想要固定人设 / 规则就填，等价于本地的同名变量 |

`ORCA_MODE=remote`、`HOST=0.0.0.0`、`ORCA_BROWSER_LOGIN=off`、三个 `*_FILE=/data/*.json` 已经在 `Dockerfile` 里设好，不用重复。

## 5. 开公网域名

**Settings** → **Networking** → **Generate Domain**，拿到 `https://xxx.up.railway.app`。

验证：

```bash
curl https://xxx.up.railway.app/health
# {"ok":true,"mode":"remote","accounts":1,"browserLogin":false,...}
```

## 6. 用起来

浏览器打开域名 → 输入 `ORCA_ADMIN_KEY` → 进控制台。

- 账号没进池子：把 Cookie 粘进「账号池」的导入框，或用 `POST /accounts`。
- 接口地址：控制台「访问密钥」顶部显示的就是当前域名下的 `/v1`，点「复制」直接用。

```bash
curl https://xxx.up.railway.app/v1/chat/completions \
  -H "content-type: application/json" \
  -H "Authorization: Bearer sk-orca-YOUR_KEY" \
  -d '{"model":"hunyuan-turbos","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

```js
const client = new OpenAI({
  apiKey: "sk-orca-YOUR_KEY",
  baseURL: "https://xxx.up.railway.app/v1",
});
```

## 7. Cookie 过期了怎么办

云上没有任何办法复用浏览器登录态，`/login` 会直接返回 501。正确姿势：

1. 本地跑 `npm run login` 抓一份新鲜 cookie；
2. 把 `data/accounts.json` 里的账号行，或控制台导出的 Cookie，粘到线上控制台的「账号池」；
3. 或者更新 `ORCA_ACCOUNTS` —— 注意它只在账号池为空时生效，已有账号请走控制台导入。

## 8. 常见坑

| 现象 | 原因 |
| --- | --- |
| 部署成功但 502 / 健康检查失败 | `HOST` 必须是 `0.0.0.0`；自己改过 `PORT` 就跟 Railway 注入的 `PORT` 冲突，别在 Variables 里设 `PORT` |
| 重新部署后 API key 变了 | 没挂 Volume，也没设 `ORCA_API_KEY` |
| 控制台「浏览器登录」是灰的 | 正常。`ORCA_BROWSER_LOGIN=off`，云端没浏览器 |
| 两个副本行为不一致 | 保持 **1 个副本**：账号池和用量统计都在进程内存里，多副本各跑各的 |
| 浏览器直连 `/v1` 报跨域 | 服务没有放 CORS 头，浏览器端应用请走服务端代理转发 |

本地先验一遍再推：

```bash
docker build -t orcaterm-gateway .
docker run --rm -p 8787:8787 -e ORCA_ADMIN_KEY=adm-test -e ORCA_API_KEY=sk-orca-test orcaterm-gateway
curl http://127.0.0.1:8787/health
```
