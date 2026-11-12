import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const MODES = ["local", "remote"];
export const DEFAULT_MODE = "local";

const ADMIN_PREFIX = "adm-";
const API_PREFIX = "sk-orca-";
const KEY_LENGTH = 40;

export function randomKey(prefix) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(KEY_LENGTH);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${prefix}${out}`;
}

export function maskKey(key) {
  const value = String(key || "");
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function newApiKey(name = "default") {
  return {
    id: randomUUID(),
    name: String(name || "default").slice(0, 40),
    key: randomKey(API_PREFIX),
    disabled: false,
    createdAt: Date.now(),
    lastUsedAt: 0,
  };
}

/**
 * data/config.json:
 *   mode      local | remote
 *   adminKey  remote 模式下进入控制台要用的 key，留空则自动生成
 *   apiKeys   调用 /v1/* 用的 key 列表，为空则自动生成一个
 *
 * local 模式只允许本机访问控制台，不需要 adminKey；
 * remote 模式必须带 adminKey 才能进控制台。
 */
export class ConfigStore {
  constructor(file) {
    this.file = file;
    this.mode = DEFAULT_MODE;
    this.adminKey = "";
    this.apiKeys = [];
    this.generatedAdminKey = false;
    this.generatedApiKey = false;
  }

  path() {
    return this.file instanceof URL ? fileURLToPath(this.file) : this.file;
  }

  async load() {
    let raw = null;
    try {
      raw = JSON.parse(await readFile(this.path(), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }

    const envMode = String(process.env.ORCA_MODE || "").toLowerCase();
    const mode = MODES.includes(envMode) ? envMode : MODES.includes(raw?.mode) ? raw.mode : DEFAULT_MODE;
    this.mode = mode;

    const envAdmin = String(process.env.ORCA_ADMIN_KEY || "").trim();
    this.adminKey = envAdmin || String(raw?.adminKey || "").trim();
    this.apiKeys = Array.isArray(raw?.apiKeys)
      ? raw.apiKeys.filter((item) => item && item.key).map((item) => ({
        id: String(item.id || randomUUID()),
        name: String(item.name || "default").slice(0, 40),
        key: String(item.key),
        disabled: Boolean(item.disabled),
        createdAt: Number(item.createdAt) || Date.now(),
        lastUsedAt: Number(item.lastUsedAt) || 0,
      }))
      : [];

    let dirty = !raw || !MODES.includes(raw?.mode);
    if (!this.apiKeys.length) {
      this.apiKeys.push(newApiKey());
      this.generatedApiKey = true;
      dirty = true;
    }
    if (this.mode === "remote" && !this.adminKey) {
      this.adminKey = randomKey(ADMIN_PREFIX);
      this.generatedAdminKey = true;
      dirty = true;
    }
    if (dirty) await this.save();
    return this;
  }

  async save() {
    const file = this.path();
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    const payload = {
      mode: this.mode,
      adminKey: this.adminKey,
      apiKeys: this.apiKeys.map((item) => ({
        id: item.id,
        name: item.name,
        key: item.key,
        disabled: item.disabled,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
      })),
    };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }

  requiresAdminKey() {
    return this.mode === "remote";
  }

  verifyAdmin(key) {
    if (!this.requiresAdminKey()) return true;
    return sameSecret(key, this.adminKey);
  }

  /** 返回命中的 key，顺便刷新 lastUsedAt（不落盘，避免每次请求都写文件）。 */
  verifyApiKey(key) {
    if (!key) return null;
    const hit = this.apiKeys.find((item) => !item.disabled && sameSecret(key, item.key));
    if (hit) hit.lastUsedAt = Date.now();
    return hit || null;
  }

  async addKey(name) {
    const item = newApiKey(name);
    this.apiKeys.push(item);
    await this.save();
    return item;
  }

  async removeKey(id) {
    const before = this.apiKeys.length;
    this.apiKeys = this.apiKeys.filter((item) => item.id !== id);
    if (this.apiKeys.length === before) return false;
    await this.save();
    return true;
  }

  async setDisabled(id, disabled) {
    const item = this.apiKeys.find((entry) => entry.id === id);
    if (!item) return false;
    item.disabled = Boolean(disabled);
    await this.save();
    return true;
  }

  /** 给控制台用：只在已通过 admin 鉴权时调用，所以带完整 key。 */
  snapshot() {
    return {
      mode: this.mode,
      adminRequired: this.requiresAdminKey(),
      adminKey: this.requiresAdminKey() ? maskKey(this.adminKey) : "",
      apiKeys: this.apiKeys.map((item) => ({
        id: item.id,
        name: item.name,
        key: item.key,
        masked: maskKey(item.key),
        disabled: item.disabled,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
      })),
    };
  }
}
