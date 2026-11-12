import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const DEFAULT_DEBUG_URL = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9222";

/**
 * 日常浏览器的用户数据目录。Chrome 打开 chrome://inspect/#remote-debugging
 * 开关后，会把调试端口写进这些目录下的 DevToolsActivePort 文件。
 */
export function profileDirs() {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [
        { name: "Chrome", dir: join(home, "Library", "Application Support", "Google", "Chrome") },
        { name: "Edge", dir: join(home, "Library", "Application Support", "Microsoft Edge") },
        { name: "Brave", dir: join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser") },
        { name: "Chromium", dir: join(home, "Library", "Application Support", "Chromium") },
      ];
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
      return [
        { name: "Chrome", dir: join(localAppData, "Google", "Chrome", "User Data") },
        { name: "Edge", dir: join(localAppData, "Microsoft", "Edge", "User Data") },
        { name: "Brave", dir: join(localAppData, "BraveSoftware", "Brave-Browser", "User Data") },
      ];
    }
    default:
      return [
        { name: "Chrome", dir: join(home, ".config", "google-chrome") },
        { name: "Chromium", dir: join(home, ".config", "chromium") },
        { name: "Edge", dir: join(home, ".config", "microsoft-edge") },
      ];
  }
}

/**
 * 收集「可能可以附身」的调试入口：
 * 1. CHROME_DEBUG_URL 显式指定
 * 2. 日常浏览器通过 chrome://inspect 开启的调试服务（端口随机，写在 DevToolsActivePort）
 * 3. 经典 --remote-debugging-port=9222
 */
export async function findDebugEndpoints() {
  const endpoints = [];
  if (process.env.CHROME_DEBUG_URL) {
    endpoints.push({ label: process.env.CHROME_DEBUG_URL, http: process.env.CHROME_DEBUG_URL });
  }
  for (const { name, dir } of profileDirs()) {
    try {
      const [port, path] = (await readFile(join(dir, "DevToolsActivePort"), "utf8")).split("\n");
      if (port?.trim() && path?.trim()) {
        endpoints.push({ label: `${name}（当前浏览器）`, ws: `ws://127.0.0.1:${port.trim()}${path.trim()}` });
      }
    } catch { /* 没有这个浏览器或者没开调试开关 */ }
  }
  endpoints.push({ label: DEFAULT_DEBUG_URL, http: DEFAULT_DEBUG_URL });
  return endpoints;
}

function candidates() {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ];
    case "win32": {
      const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
      const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
      const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
      return [
        join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      ];
    }
    default:
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/snap/bin/chromium",
      ];
  }
}

export function findBrowser() {
  const override = process.env.CHROME_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`CHROME_PATH 指向的文件不存在：${override}`);
    return override;
  }
  const found = candidates().find((item) => item && existsSync(item));
  if (!found) {
    throw new Error("没有找到 Chrome / Edge / Chromium，请先安装其中之一，或用环境变量 CHROME_PATH 指定浏览器路径");
  }
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDebugger(port, timeoutMs, hasExited) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error("浏览器启动后立刻退出，登录窗口没能打开。若配置目录被占用，请先关闭旧的登录窗口再重试");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
      lastError = new Error(`调试端口返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`浏览器调试端口 ${port} 没有起来：${lastError?.message || "超时"}`);
}

class DebugSession {
  static async connect(wsUrl, timeoutMs = 10000) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("浏览器调试端口握手超时")), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("无法连接到浏览器调试端口")); }, { once: true });
    });
    return new DebugSession(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      entry.settle(message.error ? new Error(message.error.message || "调试指令失败") : null, message.result);
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) entry.settle(new Error("浏览器调试连接已关闭"));
      this.pending.clear();
    });
  }

  send(method, { params = {}, timeoutMs = 15000, sessionId } = {}) {
    const id = (this.sequence += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器调试指令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        settle: (error, result) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(result);
        },
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try { this.socket.close(); } catch { /* 已关闭 */ }
  }
}

/** 给页面挂一个 flattened 会话，之后可用 sessionId 调页面级指令。 */
async function attachToPage(browser, preferTargetId) {
  if (browser.pageSessionId) return browser.pageSessionId;
  const { targetInfos } = await browser.session.send("Target.getTargets", { timeoutMs: 5000 });
  const pages = targetInfos.filter((info) => info.type === "page");
  const page = (preferTargetId && pages.find((info) => info.targetId === preferTargetId)) || pages[0];
  if (!page) throw new Error("浏览器里没有可用的标签页");
  const { sessionId } = await browser.session.send("Target.attachToTarget", {
    params: { targetId: page.targetId, flatten: true },
    timeoutMs: 5000,
  });
  browser.pageSessionId = sessionId;
  browser.pageTargetId = page.targetId;
  return sessionId;
}

/**
 * 不同 Chrome 版本上能用的取 cookie 通道不一样，按顺序试，
 * 成功一个就缓存下来给后续轮询复用。
 * 页面级 Network.getCookies 放第一位：Chrome 157 上它稳，而 Storage.getCookies 会挂。
 */
export async function readCookies(browser) {
  if (browser.cookieReader) return browser.cookieReader();
  const errors = [];
  const strategies = [
    ["page Network.getCookies", async () => {
      const sessionId = await attachToPage(browser, browser.createdTargetId);
      const { cookies } = await browser.session.send("Network.getCookies", {
        params: {
          urls: [
            "https://cloud.tencent.com/",
            "https://orcaterm.cloud.tencent.com/",
            "https://lightai.cloud.tencent.com/",
            "https://tencent.com/",
          ],
        },
        timeoutMs: 6000,
        sessionId,
      });
      return cookies || [];
    }],
    ["Storage.getCookies", async () => {
      const { cookies } = await browser.session.send("Storage.getCookies", { timeoutMs: 6000 });
      return cookies || [];
    }],
    ["page Storage.getCookies", async () => {
      const sessionId = await attachToPage(browser, browser.createdTargetId);
      const { cookies } = await browser.session.send("Storage.getCookies", { timeoutMs: 6000, sessionId });
      return cookies || [];
    }],
    ["Network.getAllCookies", async () => {
      const { cookies } = await browser.session.send("Network.getAllCookies", { timeoutMs: 6000 });
      return cookies || [];
    }],
  ];
  for (const [name, run] of strategies) {
    try {
      const cookies = await run();
      if (Array.isArray(cookies)) {
        browser.cookieReader = run;
        browser.cookieReaderName = name;
        return cookies;
      }
      errors.push(`${name}: 返回的不是数组`);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(`读取浏览器 Cookie 失败（${errors.join("；")}）`);
}

/**
 * 附身到一个已经在跑、开了调试服务的浏览器，在里面开一个新标签页登录。
 * 支持两种入口：chrome://inspect 开关（端口随机，DevToolsActivePort 里有），
 * 以及经典的 --remote-debugging-port。结束时只关标签页，不关浏览器。
 */
export async function attachToBrowser({ url, endpoints }) {
  const list = endpoints || await findDebugEndpoints();
  const errors = [];
  for (const endpoint of list) {
    let session;
    try {
      let wsUrl = endpoint.ws;
      if (!wsUrl) {
        const base = String(endpoint.http || "").replace(/\/+$/, "");
        const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error(`调试端口返回 ${response.status}`);
        wsUrl = (await response.json()).webSocketDebuggerUrl;
      }
      if (!wsUrl) throw new Error("没有拿到 WebSocket 地址");
      session = await DebugSession.connect(wsUrl, 8000);
      // chrome://inspect 模式会弹一次「允许调试」，这里给足点击时间
      const { targetId } = await session.send("Target.createTarget", { params: { url }, timeoutMs: 60000 });
      const close = async () => {
        try { await session.send("Target.closeTarget", { params: { targetId }, timeoutMs: 2000 }); } catch { /* 标签页已关 */ }
        session.close();
      };
      return {
        session,
        close,
        exited: () => false,
        attached: true,
        label: endpoint.label,
        createdTargetId: targetId,
      };
    } catch (error) {
      session?.close();
      errors.push(`${endpoint.label}: ${error.message}`);
    }
  }
  throw new Error(errors.length ? `没有可用的浏览器调试连接（${errors.join("；")}）` : "没有找到可附身的浏览器");
}

/**
 * 用独立的用户目录打开一个带调试端口的浏览器窗口。
 * 返回的 session 可读取该窗口里所有 cookie，close() 会关掉整个浏览器。
 */
export async function openDebugBrowser({ url, profileDir, timeoutMs = 20000 }) {
  const executable = findBrowser();
  const port = await freePort();
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-features=Translate",
    url,
  ], { detached: true, stdio: "ignore" });

  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { exited = true; });
  child.unref();

  let version;
  try {
    version = await waitForDebugger(port, timeoutMs, () => exited);
  } catch (error) {
    try { child.kill(); } catch { /* 已退出 */ }
    throw error;
  }

  const session = await DebugSession.connect(version.webSocketDebuggerUrl);
  const close = async () => {
    try { await session.send("Browser.close", { timeoutMs: 2000 }); } catch { /* 已经关了 */ }
    session.close();
    try { child.kill(); } catch { /* 已退出 */ }
  };
  return {
    session,
    close,
    exited: () => exited,
    attached: false,
    browser: version.Browser,
  };
}
