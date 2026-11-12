# OrcaTerm Gateway — Railway / 任意容器平台
#
# 项目零第三方依赖（只用 Node 内置模块），所以没有 npm install 这一步，
# 也没有 node_modules 要拷。改依赖时记得回来补 build 步骤。

FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    ORCA_MODE=remote \
    ORCA_BROWSER_LOGIN=off \
    ACCOUNTS_FILE=/data/accounts.json \
    USAGE_FILE=/data/usage.json \
    CONFIG_FILE=/data/config.json

WORKDIR /app

COPY package.json ./
COPY openapi.json ./
COPY src ./src

# 持久化目录。Railway 上给这个服务挂一个 Volume，Mount path 填 /data，
# 账号池、用量、API key 才不会在每次重新部署后清空。
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||8787)+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

# 以 root 跑：Railway 挂载的 volume 属主是 root，切成 node 用户会写不进去。
CMD ["node", "src/server.js"]
