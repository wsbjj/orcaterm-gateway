import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAccount } from "./accounts.js";
import { attachToBrowser, openDebugBrowser, readCookies } from "./browser.js";

/** 上游 lightai.cloud.tencent.com 需要的 cookie 都挂在这个域下。 */
export const LOGIN_HOST = "lightai.cloud.tencent.com";

export const DEFAULT_LOGIN_URL = "https://orcaterm.cloud.tencent.com/terminal";

const PROFILE_PREFIX = "orcaterm-login-";
const LOGGED = new Set(["starting", "waiting"]);

function bareDomain(domain) {
  return String(domain || "").replace(/^\./, "").toLowerCase();
}

export function domainMatches(domain, host = LOGIN_HOST) {
  const value = bareDomain(domain);
  if (!value) return false;
  const target = String(host || "").toLowerCase();
  return target === value || target.endsWith(`.${value}`);
}

function specificity(domain, host) {
  const value = bareDomain(domain);
  return value === String(host || "").toLowerCase() ? 10_000 : value.length;
}

/** 同名 cookie 按域精确度去重：越贴近上游域名的越优先。 */
export function selectCookies(cookies, host = LOGIN_HOST) {
  const matched = (cookies || []).filter((item) => item && item.name && domainMatches(item.domain, host));
  matched.sort((a, b) => specificity(b.domain, host) - specificity(a.domain, host));
  const picked = new Map();
  for (const item of matched) if (!picked.has(item.name)) picked.set(item.name, item);
  return [...picked.values()];
}

export function buildCookieString(cookies, host = LOGIN_HOST) {
  return selectCookies(cookies, host).map((item) => `${item.name}=${item.value}`).join("; ");
}

export function cookieState(cookies, host = LOGIN_HOST) {
  const names = new Set(selectCookies(cookies, host).map((item) => item.name));
  return {
    hasUin: names.has("uin"),
    hasSkey: names.has("skey"),
    hasPSkey: names.has("p_skey"),
    names: [...names],
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshot(job) {
  return {
    id: job.id,
    state: job.state,
    message: job.message,
    account: job.account,
    attached: job.attached,
    reader: job.reader,
    cookieCount: job.cookieNames.length,
    cookieNames: job.cookieNames,
    allCookieNames: job.allCookieNames,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function report(job, message) {
  job.message = message;
  job.updatedAt = Date.now();
  console.log(`[login:${job.id.slice(0, 8)}] ${message}`);
}

/**
 * 打开浏览器（优先附身当前浏览器开新标签页），等用户登录，
 * 轮询调试端口里的 cookie，凑齐 uin / skey / p_skey 后写入账号池。
 */
export class LoginManager {
  constructor(pool, { pollMs = 1500, keepJobs = 20 } = {}) {
    this.pool = pool;
    this.pollMs = pollMs;
    this.keepJobs = keepJobs;
    this.jobs = new Map();
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : null;
  }

  active() {
    return [...this.jobs.values()].filter((job) => LOGGED.has(job.state)).map(snapshot);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cancelled = true;
    job.close?.().catch(() => {});
    return true;
  }

  start(options = {}) {
    const job = {
      id: randomUUID(),
      state: "starting",
      message: "正在启动浏览器…",
      account: null,
      attached: null,
      reader: "",
      cookieNames: [],
      allCookieNames: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancelled: false,
      close: null,
    };
    this.jobs.set(job.id, job);
    this.prune();
    console.log(`[login:${job.id.slice(0, 8)}] 开始：mode=${options.mode || "auto"} url=${options.url || DEFAULT_LOGIN_URL}`);
    job.finished = this.run(job, options).then(
      (account) => {
        if (!account && job.state !== "done") {
          job.state = "cancelled";
          report(job, "已取消");
        }
        return account;
      },
      (error) => {
        job.state = job.cancelled ? "cancelled" : "error";
        report(job, job.cancelled ? "已取消" : `${error.message}（已见 cookie: ${job.allCookieNames.join(", ") || "无"}）`);
        return null;
      },
    );
    return snapshot(job);
  }

  async run(job, { url, timeoutMs = 300_000, mode = "auto", fresh = true, profile } = {}) {
    const target = String(url || "").trim() || DEFAULT_LOGIN_URL;
    if (!/^https?:\/\//i.test(target)) throw new Error("登录地址必须是 http(s) 链接");

    let profileDir = "";
    let temporary = false;
    let browser = null;

    try {
      if (mode !== "launch") {
        try {
          job.state = "starting";
          report(job, "正在连接当前浏览器…");
          browser = await attachToBrowser({ url: target });
          job.attached = true;
          report(job, `已在 ${browser.label} 打开新标签页，完成登录即可（若弹出「允许调试」请点允许）`);
        } catch (error) {
          if (mode === "attach") {
            throw new Error(
              `${error.message}。要用当前浏览器登录，请在浏览器地址栏打开 chrome://inspect/#remote-debugging，` +
              "勾选允许远程调试（Chrome 144+），然后重新点登录；" +
              "Chrome 136+ 已忽略默认 profile 的 --remote-debugging-port，重启加参数没用",
            );
          }
          console.log(`[login:${job.id.slice(0, 8)}] 附身当前浏览器失败，改为独立窗口：${error.message}`);
        }
      }

      if (!browser) {
        if (profile && !fresh) {
          profileDir = profile;
          await mkdir(profileDir, { recursive: true });
        } else {
          profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
          temporary = true;
        }
        job.state = "waiting";
        browser = await openDebugBrowser({ url: target, profileDir });
        job.attached = false;
        report(job, "已打开独立登录窗口，请在其中登录腾讯云");
      }

      job.state = "waiting";
      job.close = browser.close;
      if (job.cancelled) return null;

      const deadline = Date.now() + timeoutMs;
      let state = cookieState([]);
      let partialSince = 0;
      let failures = 0;
      let cookies = [];

      while (Date.now() < deadline) {
        if (job.cancelled) return null;
        if (browser.exited()) throw new Error(job.attached ? "浏览器调试连接已断开" : "登录窗口被关闭，登录中止");

        try {
          cookies = await readCookies(browser);
          failures = 0;
          if (!job.reader && browser.cookieReaderName) {
            job.reader = browser.cookieReaderName;
            console.log(`[login:${job.id.slice(0, 8)}] cookie 通道：${job.reader}`);
          }
        } catch (error) {
          browser.cookieReader = null; // 通道可能失效，下一轮重新挑选
          failures += 1;
          if (failures >= 5) throw new Error(`连续读取 Cookie 失败：${error.message}`);
          console.log(`[login:${job.id.slice(0, 8)}] 读取 Cookie 失败（第 ${failures} 次）：${error.message}`);
          await delay(this.pollMs);
          continue;
        }

        state = cookieState(cookies);
        job.cookieNames = state.names;
        job.allCookieNames = [...new Set((cookies || []).map((item) => item?.name).filter(Boolean))];
        job.updatedAt = Date.now();

        // skey 到手就能用（腾讯云现在的流程根本不发 p_skey），有 p_skey 更好
        if (state.hasUin && state.hasSkey) break;
        if (state.hasUin && state.hasPSkey) {
          if (!partialSince) partialSince = Date.now();
          if (job.message !== "已拿到 uin，正在等待 skey…") report(job, "已拿到 uin，正在等待 skey…");
          if (Date.now() - partialSince > 6000) break;
        }
        await delay(this.pollMs);
      }

      if (!state.hasUin || (!state.hasSkey && !state.hasPSkey)) {
        throw new Error(
          `${job.cancelled ? "已取消" : "登录超时"}，相关 cookie: ${state.names.join(", ") || "无"}，` +
          `浏览器全部 cookie: ${job.allCookieNames.slice(0, 20).join(", ") || "无"}`,
        );
      }

      cookies = await readCookies(browser);
      const cookie = buildCookieString(cookies);
      let account;
      try {
        account = parseAccount({ cookie });
      } catch (error) {
        throw new Error(`登录完成但账号信息不完整：${error.message}`);
      }

      await this.pool.add(JSON.stringify({ accounts: [{ cookie }] }));

      job.state = "done";
      job.account = { uin: account.uin, hasSkey: Boolean(account.skey), hasPSkey: Boolean(account.pSkey) };
      const creds = [account.skey ? "skey" : "", account.pSkey ? "p_skey" : "", account.extraCookies.length ? `${account.extraCookies.length} 个附加 cookie` : ""].filter(Boolean).join(" + ");
      report(job, `登录成功，账号已写入账号池（uin=${account.uin}，凭据 ${creds || "无"}，通道 ${job.reader}）`);
      return job.account;
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (temporary) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  prune() {
    const finished = [...this.jobs.values()].filter((job) => !LOGGED.has(job.state));
    if (finished.length <= this.keepJobs) return;
    finished.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of finished.slice(0, finished.length - this.keepJobs)) this.jobs.delete(job.id);
  }
}
