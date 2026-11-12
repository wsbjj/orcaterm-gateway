import { DEFAULT_LOGIN_URL, LoginManager } from "./login.js";
import { AccountPool } from "./pool.js";

const url = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const mode = process.argv.includes("--attach") ? "attach" : process.argv.includes("--launch") ? "launch" : process.env.LOGIN_MODE || "auto";
const file = process.env.ACCOUNTS_FILE || new URL("../data/accounts.json", import.meta.url);

const pool = new AccountPool(file);
await pool.load();

const manager = new LoginManager(pool);
const job = manager.start({ url, mode });

console.log(`登录地址：${url || DEFAULT_LOGIN_URL}  模式：${mode}`);
console.log("浏览器就位后，在打开的窗口/标签页里完成腾讯云登录。按 Ctrl+C 可取消。");

let lastMessage = "";
const timer = setInterval(() => {
  const current = manager.get(job.id);
  if (!current) return;
  if (current.message !== lastMessage) {
    lastMessage = current.message;
    console.log(`[${current.state}] ${current.message}`);
  }
  if (current.state === "done") {
    clearInterval(timer);
    console.log(`\n账号 uin=${current.account.uin} 已写入 ${pool.filePath()}`);
    console.log(`skey: ${current.account.hasSkey ? "有" : "无"}  p_skey: ${current.account.hasPSkey ? "有" : "无"}`);
    console.log(`当前账号池共 ${pool.list().length} 个账号`);
    process.exit(0);
  }
  if (["error", "cancelled"].includes(current.state)) {
    clearInterval(timer);
    console.error(`\n登录失败：${current.message}`);
    process.exit(1);
  }
}, 800);

process.on("SIGINT", () => {
  manager.cancel(job.id);
  clearInterval(timer);
  console.error("\n已取消登录");
  process.exit(130);
});
