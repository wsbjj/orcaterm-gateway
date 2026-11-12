import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUin, parseAccount, parseAccounts } from "./accounts.js";

export class AccountPool {
  constructor(file) {
    this.file = file;
    this.accounts = [];
    this.cursor = 0;
    this.failures = new Map();
  }

  async load() {
    try {
      this.accounts = parseAccounts(await readFile(this.filePath(), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.accounts = [];
    }
  }

  list() {
    return this.accounts.map((account) => ({
      id: account.id,
      uin: account.uin,
      hasSkey: Boolean(account.skey),
      hasPSkey: Boolean(account.pSkey),
      disabled: account.disabled,
      failures: this.failures.get(account.id) || 0,
    }));
  }

  filePath() {
    return this.file instanceof URL ? fileURLToPath(this.file) : this.file;
  }

  async save() {
    const file = this.filePath();
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    const stored = this.accounts.map((account) => ({
      id: account.id,
      uin: account.uin,
      skey: account.skey,
      p_skey: account.pSkey,
      extraCookies: account.extraCookies,
      disabled: account.disabled,
    }));
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }

  async replace(text) {
    this.accounts = parseAccounts(text);
    this.cursor = 0;
    this.failures.clear();
    await this.save();
    return this.list();
  }

  async add(text) {
    const incoming = parseAccounts(text).map(parseAccount);
    for (const account of incoming) {
      const index = this.accounts.findIndex((item) => item.uin === account.uin);
      if (index >= 0) this.accounts[index] = account;
      else this.accounts.push(account);
    }
    await this.save();
    return this.list();
  }

  async remove(id) {
    const target = String(id || "");
    const normalized = normalizeUin(target);
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((account) => {
      if (account.id === target) return false;
      if (account.uin === target) return false;
      if (normalized && account.uin === normalized) return false;
      return true;
    });
    if (this.accounts.length === before) return false;
    await this.save();
    return true;
  }

  next() {
    const usable = this.accounts.filter((account) => !account.disabled);
    if (!usable.length) {
      const error = new Error("没有可用账号，请先导入 uin 和 skey/p_skey");
      error.status = 503;
      throw error;
    }
    const account = usable[this.cursor % usable.length];
    this.cursor += 1;
    return account;
  }

  mark(account, ok) {
    if (ok) this.failures.delete(account.id);
    else this.failures.set(account.id, (this.failures.get(account.id) || 0) + 1);
  }
}
