import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";

export const HOMEPAGE = "https://github.com/xtongs/repolens";

export interface MenuActions {
  addRepository: () => void;
  openSettings: () => void;
  checkForUpdates: () => void;
  openLogs: () => void;
}

/**
 * 应用菜单。
 *
 * macOS 上没有「编辑」菜单，输入框里的 ⌘C / ⌘V 就不起作用，所以即使界面本身
 * 用不到，复制粘贴这几项也必须挂上。各项都给了中文标签，不依赖系统语言。
 */
export function buildMenu(actions: MenuActions): Menu {
  const isMac = process.platform === "darwin";
  const separator: MenuItemConstructorOptions = { type: "separator" };
  const settings: MenuItemConstructorOptions = {
    label: "设置…",
    accelerator: "CmdOrCtrl+,",
    click: actions.openSettings,
  };
  const checkForUpdates: MenuItemConstructorOptions = { label: "检查更新…", click: actions.checkForUpdates };

  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about", label: `关于 ${app.name}` },
        checkForUpdates,
        separator,
        settings,
        separator,
        { role: "services", label: "服务" },
        separator,
        { role: "hide", label: `隐藏 ${app.name}` },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        separator,
        { role: "quit", label: `退出 ${app.name}` },
      ],
    });
  }

  template.push(
    {
      label: "文件",
      submenu: [
        { label: "添加仓库…", accelerator: "CmdOrCtrl+O", click: actions.addRepository },
        ...(isMac ? [] : [separator, settings]),
        separator,
        isMac ? { role: "close", label: "关闭窗口" } : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        separator,
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        separator,
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        separator,
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [separator, { role: "front", label: "前置全部窗口" } as MenuItemConstructorOptions]
          : [{ role: "close", label: "关闭" } as MenuItemConstructorOptions]),
      ],
    },
    {
      role: "help",
      label: "帮助",
      submenu: [
        { label: "项目主页", click: () => void shell.openExternal(HOMEPAGE) },
        { label: "反馈问题", click: () => void shell.openExternal(`${HOMEPAGE}/issues`) },
        { label: "打开日志文件夹", click: actions.openLogs },
        ...(isMac ? [] : [separator, checkForUpdates, { role: "about", label: `关于 ${app.name}` } as MenuItemConstructorOptions]),
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}
