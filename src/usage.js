import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const empty = () => ({
  total: { requests: 0, errors: 0, promptChars: 0, completionChars: 0 },
  byModel: {},
  byAccount: {},
  days: {},
  models: {},
  updatedAt: 0,
});

function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function bump(bucket, key, field, amount) {
  bucket[key] ||= { requests: 0, errors: 0, promptChars: 0, completionChars: 0 };
  bucket[key][field] += amount;
}

/**
 * 上游 lightai.cloud.tencent.com 没有任何额度/余额接口（/quota、/usage、
 * /balance 全部 404），所以只能本地记账：请求数、字符数、错误数，按模型和账号分组。
 * 字符数是估算 token 的依据，不是计费值。
 */
export class UsageStore {
  constructor(file) {
    this.file = file;
    this.data = empty();
    this.timer = null;
  }

  path() {
    return this.file instanceof URL ? fileURLToPath(this.file) : this.file;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8"));
      this.data = { ...empty(), ...parsed };
    } catch {
      this.data = empty();
    }
  }

  record({ account, model, promptChars = 0, completionChars = 0, ok = true, error = "" }) {
    const data = this.data;
    const day = dayKey();
    const entry = { requests: 1, errors: ok ? 0 : 1, promptChars, completionChars };
    const today = (data.days[day] ||= { requests: 0, errors: 0, promptChars: 0, completionChars: 0 });
    for (const [bucket, key] of [[data.total, null], [data.byModel, model || "unknown"], [data.byAccount, account || "unknown"], [today, null]]) {
      if (key === null) {
        bucket.requests += entry.requests;
        bucket.errors += entry.errors;
        bucket.promptChars += promptChars;
        bucket.completionChars += completionChars;
      } else {
        bump(bucket, key, "requests", 1);
        bump(bucket, key, "errors", ok ? 0 : 1);
        bump(bucket, key, "promptChars", promptChars);
        bump(bucket, key, "completionChars", completionChars);
      }
    }
    const health = (data.models[model] ||= { ok: 0, fail: 0, lastError: "", lastCheckedAt: 0 });
    health[ok ? "ok" : "fail"] += 1;
    health.lastCheckedAt = Date.now();
    if (!ok) health.lastError = String(error).slice(0, 200);
    data.updatedAt = Date.now();
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save().catch(() => {});
    }, 1000);
    this.timer.unref?.();
  }

  async save() {
    const file = this.path();
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }

  snapshot() {
    const today = this.data.days[dayKey()] || { requests: 0, errors: 0, promptChars: 0, completionChars: 0 };
    return {
      total: this.data.total,
      today,
      byModel: this.data.byModel,
      byAccount: this.data.byAccount,
      models: this.data.models,
      updatedAt: this.data.updatedAt,
    };
  }
}

export { dayKey };
