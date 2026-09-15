import type { ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { dirOf, joinPosix } from "./path-utils.js";

/** 模块文件的候选扩展名，顺序即优先级 */
const MODULE_EXTENSIONS = [".py", ".pyi"] as const;

/**
 * 常见标准库顶层模块。
 *
 * 不求穷尽：这份清单只用来把「肯定不在仓库里」的导入直接判成 external，
 * 漏掉的名字会走到后面的兜底分支，最差也只是被当成第三方依赖，同样是 external。
 */
const STDLIB_MODULES: ReadonlySet<string> = new Set([
  "__future__", "abc", "argparse", "array", "ast", "asyncio", "base64", "bisect", "builtins",
  "bz2", "calendar", "cmath", "collections", "concurrent", "configparser", "contextlib", "copy",
  "csv", "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis", "email", "enum",
  "errno", "faulthandler", "filecmp", "fnmatch", "fractions", "ftplib", "functools", "gc",
  "getpass", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib", "importlib",
  "inspect", "io", "ipaddress", "itertools", "json", "keyword", "linecache", "locale", "logging",
  "lzma", "mailbox", "marshal", "math", "mimetypes", "mmap", "multiprocessing", "numbers",
  "operator", "os", "pathlib", "pickle", "pkgutil", "platform", "plistlib", "pprint", "queue",
  "random", "re", "readline", "reprlib", "resource", "runpy", "sched", "secrets", "select",
  "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtplib", "socket",
  "socketserver", "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess",
  "sys", "sysconfig", "tarfile", "tempfile", "termios", "textwrap", "threading", "time",
  "timeit", "token", "tokenize", "traceback", "tracemalloc", "types", "typing",
  "typing_extensions", "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings",
  "weakref", "webbrowser", "xml", "zipfile", "zlib", "zoneinfo",
]);

/**
 * Python 模块解析器。
 *
 * 相对导入和绝对导入的失败语义不同，这是这个解析器的核心取舍：
 * 相对导入的目标**必然**在仓库里，找不到就是 unresolved，必须暴露给用户；
 * 绝对导入则大概率是第三方，找不到时只有「看起来像仓库内的包」才报 unresolved，
 * 否则一律 external——否则整个 requirements.txt 都会变成解析失败。
 */
export function createPythonResolver(): ModuleResolver {
  return {
    languages: ["python"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      if (specifier.length === 0) {
        return { status: "unresolved", reason: "空说明符" };
      }

      if (specifier.startsWith(".")) {
        return resolveRelative(specifier, ctx);
      }

      const segments = specifier.split(".").filter((s) => s.length > 0);
      const top = segments[0];
      if (top === undefined) {
        return { status: "unresolved", reason: `无法解析的模块路径：${specifier}` };
      }

      const roots = sourceRoots(ctx);
      for (const root of roots) {
        const hit = tryModule(joinPosix(root, segments.join("/")), ctx);
        if (hit) return { status: "internal", target: hit };
      }

      if (STDLIB_MODULES.has(top)) {
        return { status: "external", name: top };
      }

      // 顶层名字在仓库里有同名包目录/声明包，说明本该解析成功，报出来而不是吞掉
      if (looksInternal(top, roots, ctx)) {
        return { status: "unresolved", reason: `仓库内存在包 ${top}，但 ${specifier} 没有对应模块文件` };
      }

      return { status: "external", name: top };
    },
  };
}

// ---------------------------------------------------------------------------
// 相对导入
// ---------------------------------------------------------------------------

/**
 * `from .x import y` / `from ..x import y` / `from . import x`
 *
 * 一个点 = 当前文件所在的包目录（`__init__.py` 和普通模块在这一点上一致：
 * 两者的「当前包」都是自己所在的目录），每多一个点再往上一层。
 */
function resolveRelative(specifier: string, ctx: ResolveContext): ResolveOutcome {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const rest = specifier.slice(dots);

  const base = upLevels(dirOf(ctx.fromFile), dots - 1);
  if (base === null) {
    return { status: "unresolved", reason: `相对导入 ${specifier} 越过了仓库根目录` };
  }

  if (rest.length === 0) {
    const initFile = joinPosix(base, "__init__.py");
    if (ctx.hasFile(initFile)) return { status: "internal", target: initFile };
    return { status: "unresolved", reason: `包目录 ${base} 缺少 __init__.py` };
  }

  const hit = tryModule(joinPosix(base, rest.split(".").join("/")), ctx);
  if (hit) return { status: "internal", target: hit };

  return { status: "unresolved", reason: `相对导入 ${specifier} 在 ${base} 下无匹配模块` };
}

/** 从 dir 往上走 n 层；越过仓库根返回 null */
function upLevels(dir: string, levels: number): string | null {
  let current = dir;
  for (let i = 0; i < levels; i++) {
    if (current === ".") return null;
    current = dirOf(current);
  }
  return current;
}

// ---------------------------------------------------------------------------
// 候选路径
// ---------------------------------------------------------------------------

/** `a/b/c` → `a/b/c.py` / `a/b/c/__init__.py` / `a/b/c.pyi` */
function tryModule(base: string, ctx: ResolveContext): string | null {
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (ctx.hasFile(candidate)) return candidate;
    const packageInit = joinPosix(base, `__init__${ext}`);
    if (ctx.hasFile(packageInit)) return packageInit;
  }
  return null;
}

/**
 * 绝对导入的搜索根。
 *
 * Python 没有配置文件能可靠地告诉我们 sys.path，只能按社区惯例枚举：
 * 仓库根、`src/` 布局、以及每个 pyproject 声明的包目录及其 `src/`。
 */
function sourceRoots(ctx: ResolveContext): string[] {
  const roots: string[] = ["."];
  const add = (dir: string): void => {
    if (dir !== "." && !roots.includes(dir) && ctx.hasDir(dir)) roots.push(dir);
  };

  add("src");
  for (const pkg of ctx.packages) {
    if (pkg.manager !== "python") continue;
    add(pkg.dir);
    add(joinPosix(pkg.dir, "src"));
  }
  return roots;
}

function looksInternal(top: string, roots: readonly string[], ctx: ResolveContext): boolean {
  for (const root of roots) {
    if (ctx.hasDir(joinPosix(root, top))) return true;
  }
  return ctx.packages.some((p) => p.manager === "python" && normalizeDistName(p.name) === top);
}

/** PyPI 发行名用 `-`，导入名用 `_` */
function normalizeDistName(name: string): string {
  return name.replace(/-/g, "_");
}
