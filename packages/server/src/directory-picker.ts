import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CANCELLED = "__REPOLENS_DIRECTORY_PICKER_CANCELLED__";

export class DirectoryPickerUnavailableError extends Error {}

/**
 * 打开操作系统目录选择器，而不是让浏览器提交一段任意路径。
 *
 * 浏览器的 directory input 不会暴露目录的本机绝对路径，无法交给扫描器；
 * 接受前端传来的绝对路径又会破坏 RepoPool 的安全边界。因此由只监听本机的
 * Node 服务直接唤起系统选择器，并只信任系统选择器返回的目录。
 */
export async function pickDirectory(): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new DirectoryPickerUnavailableError(
      "当前可视化目录选择仅支持 macOS；请先运行 `repolens scan <路径>`",
    );
  }

  const script = [
    "try",
    '  POSIX path of (choose folder with prompt "选择要添加到 RepoLens 的代码仓库")',
    "on error number -128",
    `  return "${CANCELLED}"`,
    "end try",
  ].join("\n");

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const selected = stdout.trim();
    return selected === CANCELLED || selected.length === 0 ? null : selected;
  } catch (err) {
    throw new DirectoryPickerUnavailableError(
      `无法打开系统目录选择器：${(err as Error).message}`,
    );
  }
}
