import { ACCESS_TOKEN_COOKIE } from "@repolens/server/auth";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopCommand } from "../../web/src/lib/desktop.js";
import { IPC } from "./ipc.js";
import { LocalServer } from "./local-server.js";
import { isLocale, locale, setLocale, tr } from "./locale.js";
import { buildMenu, HOMEPAGE } from "./menu.js";
import {
  keyEnvUpdate,
  parseLlmSettingsInput,
  readLlmSettings,
  readState,
  writeLlmSettings,
  writeState,
  type WindowState,
} from "./settings.js";
import { readShellEnv } from "./shell-env.js";
import { setupUpdater } from "./updater.js";

const APP_DIR = app.getAppPath();
const DEFAULT_SIZE = { width: 1440, height: 900 };
/** 一分钟内崩溃超过这么多次就不再自动拉起，免得陷入重启循环 */
const MAX_CRASHES_PER_MINUTE = 3;

let mainWindow: BrowserWindow | null = null;
let origin = "";
let injectedKeyEnv: string | null = null;
const crashTimes: number[] = [];

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppLogsPath();
  const logsDir = app.getPath("logs");
  mkdirSync(logsDir, { recursive: true });
  const log = (line: string) => {
    try {
      appendFileSync(join(logsDir, "main.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // 日志写不了不影响使用
    }
  };

  const server = new LocalServer({
    entry: join(APP_DIR, "server.js"),
    webRoot: join(APP_DIR, "web"),
    logFile: join(logsDir, "server.log"),
    pickDirectory,
    onCrash: (code) => void recoverServer(code),
  });

  async function connect(): Promise<void> {
    const { name, values } = keyEnvUpdate(null);
    const port = await server.start(values);
    injectedKeyEnv = name;
    origin = `http://127.0.0.1:${port}`;
    // 页面同源请求自动带上 cookie，前端代码不需要知道令牌的存在
    await session.defaultSession.cookies.set({
      url: origin,
      name: ACCESS_TOKEN_COOKIE,
      value: server.accessToken,
      httpOnly: true,
      sameSite: "strict",
    });
  }

  async function recoverServer(code: number): Promise<void> {
    const now = Date.now();
    crashTimes.push(now);
    while ((crashTimes[0] ?? now) < now - 60_000) crashTimes.shift();
    log(`服务进程意外退出（代码 ${code}）`);
    if (crashTimes.length > MAX_CRASHES_PER_MINUTE) {
      dialog.showErrorBox(
        tr("RepoLens 服务反复退出", "The RepoLens server keeps exiting"),
        tr(`已停止自动重启。日志在：\n${logsDir}`, `Automatic restart has stopped. Logs are in:\n${logsDir}`),
      );
      return;
    }
    try {
      const repo = mainWindow ? repoOf(mainWindow.webContents.getURL()) : undefined;
      await connect();
      if (mainWindow) void mainWindow.loadURL(pageUrl(repo));
    } catch (err) {
      dialog.showErrorBox(
        tr("RepoLens 服务无法重启", "The RepoLens server couldn't restart"),
        `${(err as Error).message}\n\n${tr("日志在：", "Logs are in: ")}${logsDir}`,
      );
    }
  }

  async function pickDirectory(): Promise<string | null> {
    const options: OpenDialogOptions = {
      title: tr("选择要添加到 RepoLens 的代码仓库", "Choose a code repository to add to RepoLens"),
      buttonLabel: tr("添加", "Add"),
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  function pageUrl(repo: string | undefined): string {
    return `${origin}/${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
  }

  function repoOf(url: string): string | undefined {
    try {
      return new URL(url).searchParams.get("repo") || undefined;
    } catch {
      return undefined;
    }
  }

  /** 保存的位置落在已经拔掉的显示器上时，退回默认大小居中 */
  function initialBounds(saved: WindowState | undefined): Partial<WindowState> {
    if (!saved) return DEFAULT_SIZE;
    const { x, y, width, height } = saved;
    if (x === undefined || y === undefined) return { width, height };
    const visible = screen.getAllDisplays().some(({ workArea: area }) =>
      x < area.x + area.width && x + width > area.x && y < area.y + area.height && y + height > area.y);
    return visible ? { x, y, width, height } : { width, height };
  }

  function createWindow(): BrowserWindow {
    const saved = readState().window;
    const win = new BrowserWindow({
      ...initialBounds(saved),
      // 与界面的最小宽度一致，窗口拖到最窄时顶栏也不会出现横向滚动
      minWidth: 1024,
      minHeight: 600,
      show: false,
      title: "RepoLens",
      backgroundColor: "#0b0d10",
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
        : { autoHideMenuBar: true }),
      ...(process.platform === "linux" ? { icon: join(APP_DIR, "icon.png") } : {}),
      webPreferences: {
        preload: join(APP_DIR, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    if (saved?.maximized) win.maximize();

    win.once("ready-to-show", () => win.show());
    win.webContents.on("did-finish-load", () => win.webContents.send(IPC.fullScreen, win.isFullScreen()));
    win.on("enter-full-screen", () => win.webContents.send(IPC.fullScreen, true));
    win.on("leave-full-screen", () => win.webContents.send(IPC.fullScreen, false));
    win.on("close", () => {
      const bounds = win.getNormalBounds();
      writeState({
        window: { ...bounds, maximized: win.isMaximized() },
        lastRepo: repoOf(win.webContents.getURL()) ?? readState().lastRepo,
      });
    });
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });

    // 页面只允许停留在本地服务上；外部链接交给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith(`${origin}/`)) return;
      event.preventDefault();
      openExternal(url);
    });
    // Electron 没有默认右键菜单，输入框和选中文字至少要能复制粘贴
    win.webContents.on("context-menu", (_event, params) => {
      const items: MenuItemConstructorOptions[] = params.isEditable
        ? [
          { role: "cut", label: tr("剪切", "Cut") },
          { role: "copy", label: tr("复制", "Copy") },
          { role: "paste", label: tr("粘贴", "Paste") },
          { type: "separator" },
          { role: "selectAll", label: tr("全选", "Select All") },
        ]
        : params.selectionText.trim() !== ""
          ? [{ role: "copy", label: tr("复制", "Copy") }]
          : [];
      if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
    });

    void win.loadURL(pageUrl(readState().lastRepo));
    return win;
  }

  function openExternal(url: string): void {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  }

  /** 菜单命令发给页面；窗口刚被关掉时先重新打开，页面还没加载完的命令就不补发了 */
  function sendCommand(command: DesktopCommand): void {
    if (!origin) return;
    if (!mainWindow) {
      mainWindow = createWindow();
      return;
    }
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.command, command);
  }

  function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return origin !== "" && (event.senderFrame?.url ?? "").startsWith(`${origin}/`);
  }

  function assertFromApp(event: IpcMainInvokeEvent): void {
    if (!fromApp(event)) throw new Error(tr("拒绝来自未知页面的请求", "Rejected a request from an unknown page"));
  }

  ipcMain.handle(IPC.getLlmSettings, (event) => {
    assertFromApp(event);
    return readLlmSettings();
  });

  ipcMain.handle(IPC.saveLlmSettings, async (event, input: unknown) => {
    assertFromApp(event);
    writeLlmSettings(parseLlmSettingsInput(input));
    const { name, values } = keyEnvUpdate(injectedKeyEnv);
    injectedKeyEnv = name;
    await server.setEnv(values);
    return readLlmSettings();
  });

  // 页面每次加载都会报一次；只有语言真的变了才重建菜单并记下来
  ipcMain.on(IPC.setLocale, (event, value: unknown) => {
    if (!fromApp(event) || !isLocale(value) || value === locale()) return;
    setLocale(value);
    writeState({ locale: value });
    applyMenu();
  });

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (!mainWindow && origin) mainWindow = createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => server.stop());

  let updater: ReturnType<typeof setupUpdater> | null = null;

  /** 菜单和关于面板里的文案按当前语言生成，换语言后重新调用 */
  function applyMenu(): void {
    app.setAboutPanelOptions({
      applicationName: "RepoLens",
      applicationVersion: app.getVersion(),
      copyright: tr("本地代码仓库理解工具", "Understand local code repositories"),
      website: HOMEPAGE,
    });
    Menu.setApplicationMenu(buildMenu({
      addRepository: () => sendCommand("add-repository"),
      openSettings: () => sendCommand("open-settings"),
      checkForUpdates: () => updater?.checkNow(),
      openLogs: () => void shell.openPath(logsDir),
    }));
  }

  void app.whenReady().then(async () => {
    updater = setupUpdater(() => mainWindow, log);
    const savedLocale = readState().locale;
    if (savedLocale) setLocale(savedLocale);
    applyMenu();

    // 从终端启动时环境已经齐全；从 Dock / 桌面菜单启动才需要补读 shell 配置。
    const readsShell = process.platform !== "win32" && !process.env["TERM"];
    const shellEnv = readsShell ? readShellEnv() : Promise.resolve(null);

    try {
      await connect();
    } catch (err) {
      log(`服务启动失败：${(err as Error).stack ?? String(err)}`);
      dialog.showErrorBox(
        tr("RepoLens 无法启动", "RepoLens couldn't start"),
        `${(err as Error).message}\n\n${tr("日志在：", "Logs are in: ")}${logsDir}`,
      );
      app.quit();
      return;
    }

    // 读 shell 通常一两秒，稍等一下可以避免页面先显示「AI 未配置」再变过来。
    // 刚安装后第一次启动、zsh 插件多时可能要十几秒，不能让窗口一直等着，
    // 先打开，读到后再补给服务进程并让页面刷新状态。
    const applyShellEnv = shellEnv.then(async (imported) => {
      if (!imported) {
        if (readsShell) log("未能读取登录 shell 的环境变量");
        return false;
      }
      Object.assign(process.env, imported);
      // 在设置里保存的 key 优先于 shell 里 export 的
      await server.setEnv({ ...imported, ...keyEnvUpdate(null).values });
      return true;
    });
    const appliedBeforeWindow = await Promise.race([
      applyShellEnv,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    mainWindow = createWindow();
    updater.checkInBackground();
    if (appliedBeforeWindow === null && await applyShellEnv) {
      mainWindow?.webContents.send(IPC.command, "refresh-status" satisfies DesktopCommand);
    }
  });
}
