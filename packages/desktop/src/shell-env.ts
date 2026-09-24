import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** 这些变量描述的是那个一次性 shell 自己，不属于用户配置 */
const SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID"]);

/**
 * 读取用户登录 shell 里的环境变量。
 *
 * 从 Dock、Finder 或桌面环境的菜单启动时，应用只继承系统会话的精简环境，
 * 读不到 ~/.zshrc 里 export 的 OPENAI_API_KEY、代理和 PATH。命令行用户早就
 * 配好的这些不该在桌面端再配一遍，所以用交互式登录 shell 跑一次 `env -0` 取回来。
 * 前后加随机标记，是为了剥掉 rc 文件里 echo 出来的欢迎语之类的噪音。
 *
 * Windows 的环境变量来自注册表，由系统直接给到应用，不需要这一步。
 */
export function readShellEnv(timeoutMs = 10_000): Promise<Record<string, string> | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  const shell = process.env["SHELL"] || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const mark = randomUUID();

  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", `printf '%s' '${mark}'; command env -0; printf '%s' '${mark}'`], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      const start = output.indexOf(mark);
      const end = output.lastIndexOf(mark);
      if (start < 0 || end <= start) return resolve(null);

      const env: Record<string, string> = {};
      for (const entry of output.slice(start + mark.length, end).split("\0")) {
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const name = entry.slice(0, eq);
        if (!SKIP.has(name)) env[name] = entry.slice(eq + 1);
      }
      resolve(env);
    });
  });
}
