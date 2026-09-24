import { app, dialog, shell, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { HOMEPAGE } from "./menu.js";

/** 未签名的 macOS 应用装不了自动更新（Squirrel.Mac 会校验签名），只能提示去下载 */
const CAN_INSTALL = process.platform !== "darwin";

/**
 * 从 GitHub Releases 检查新版本。
 *
 * 启动后在后台静默检查一次，失败不打扰；菜单里的「检查更新…」会把
 * 结果（包括「已是最新」和出错）都用对话框告诉用户。
 */
export function setupUpdater(getWindow: () => BrowserWindow | null, log: (line: string) => void) {
  autoUpdater.autoDownload = CAN_INSTALL;
  autoUpdater.logger = {
    info: (message?: unknown) => log(`[updater] ${String(message)}`),
    warn: (message?: unknown) => log(`[updater] ${String(message)}`),
    error: (message?: unknown) => log(`[updater] ${String(message)}`),
  };

  let manual = false;
  const show = (options: Electron.MessageBoxOptions) => {
    const win = getWindow();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };

  autoUpdater.on("update-available", (info) => {
    if (CAN_INSTALL) {
      if (manual) void show({ type: "info", message: `发现新版本 ${info.version}`, detail: "正在后台下载，完成后会提示你重启安装。" });
      manual = false;
      return;
    }
    manual = false;
    void show({
      type: "info",
      message: `发现新版本 ${info.version}`,
      detail: "前往下载页面获取安装包。",
      buttons: ["前往下载", "稍后"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) void shell.openExternal(`${HOMEPAGE}/releases/tag/v${info.version}`);
    });
  });

  autoUpdater.on("update-not-available", () => {
    if (manual) void show({ type: "info", message: "已是最新版本", detail: `当前版本 ${app.getVersion()}` });
    manual = false;
  });

  autoUpdater.on("update-downloaded", (info) => {
    void show({
      type: "info",
      message: `新版本 ${info.version} 已下载`,
      detail: "重启 RepoLens 完成安装。",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on("error", (err) => {
    log(`[updater] ${err.stack ?? err.message}`);
    if (manual) void show({ type: "warning", message: "检查更新失败", detail: err.message });
    manual = false;
  });

  return {
    checkInBackground() {
      if (!app.isPackaged) return;
      setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 10_000);
    },
    checkNow() {
      if (!app.isPackaged) {
        void show({ type: "info", message: "开发版本不检查更新" });
        return;
      }
      manual = true;
      void autoUpdater.checkForUpdates().catch(() => {});
    },
  };
}
