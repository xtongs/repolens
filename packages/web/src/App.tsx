import { useEffect } from "react";
import { GraphCanvas } from "./graph/GraphCanvas";
import { TraceView } from "./trace/TraceView";
import { DetailDrawer } from "./layout/DetailDrawer";
import { TopBar } from "./layout/TopBar";
import { TreePanel } from "./layout/TreePanel";
import { desktop } from "./lib/desktop";
import { CommandPalette } from "./overlays/CommandPalette";
import { HelpSheet } from "./overlays/HelpSheet";
import { SettingsDialog } from "./overlays/SettingsDialog";
import { useAppStore } from "./store/useAppStore";
import { useChatStore } from "./store/useChatStore";

/** ⌘I：对话没开就打开并聚焦；开着但焦点不在输入框就拉回焦点；已在输入框里则收起 */
function toggleChat(): void {
  const { chatOpen, setChatOpen } = useAppStore.getState();
  const typing = document.activeElement instanceof HTMLTextAreaElement &&
    document.activeElement.closest("aside") !== null;
  if (chatOpen && typing) setChatOpen(false);
  else useChatStore.getState().open();
}

export function App() {
  const boot = useAppStore((s) => s.boot);
  const bootError = useAppStore((s) => s.bootError);
  const overview = useAppStore((s) => s.overview);
  const escape = useAppStore((s) => s.escape);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const traceId = useAppStore((s) => s.traceId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const noRepo = useAppStore((s) => s.noRepo);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!desktop) return;
    const offCommand = desktop.onCommand((command) => {
      const store = useAppStore.getState();
      if (command === "add-repository") store.requestAddRepo();
      if (command === "open-settings") store.setSettingsOpen(true);
    });
    const offFullScreen = desktop.onFullScreenChange((fullScreen) => {
      document.documentElement.toggleAttribute("data-fullscreen", fullScreen);
    });
    return () => {
      offCommand();
      offFullScreen();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 输入法组字时的 Esc 是取消候选词，不是退出
      if (event.isComposing) return;
      if (event.key === "Escape") {
        escape();
        return;
      }
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key.toLowerCase() === "i" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escape, setPaletteOpen]);

  // 顶栏在出错时也要留着。换到一个索引已失效的仓库后，唯一的退路就是
  // 顶栏里的仓库选择器；把它一起换成错误页，人就只能去重启进程了。
  return (
    <div className="flex h-full flex-col">
      <TopBar />

      <main className="relative flex-1 overflow-hidden">
        {bootError !== null ? (
          <BootFailure message={bootError} />
        ) : noRepo ? (
          <Welcome />
        ) : overview === null ? (
          <BootSkeleton />
        ) : (
          traceId ? (
            <TraceView key={`trace:${repoRevision}`} traceId={traceId} />
          ) : (
            <GraphCanvas key={`graph:${repoRevision}`} />
          )
        )}
        <TreePanel />
        <DetailDrawer />
      </main>

      <CommandPalette />
      <HelpSheet />
      {desktop && <SettingsDialog />}
    </div>
  );
}

function Welcome() {
  const requestAddRepo = useAppStore((s) => s.requestAddRepo);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="text-[15px] font-medium">打开一个代码仓库</div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
          选择本机的代码目录，RepoLens 会在本地建立索引，之后就能浏览架构分层、调用关系和关键链路。
          启用 AI 后，生成摘要和回答追问时会把相关代码发给你配置的模型服务。
        </p>
        <button
          type="button"
          onClick={requestAddRepo}
          className="mt-5 rounded-md bg-[var(--color-accent)] px-4 py-2 text-[12px] font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90"
        >
          添加本地仓库
        </button>
        {!desktop && (
          <p className="mono mt-4 text-[11px] text-[var(--color-ink-faint)]">
            也可以在终端运行 repolens scan &lt;仓库路径&gt;
          </p>
        )}
      </div>
    </div>
  );
}

function BootFailure({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="text-[14px] font-medium">无法加载索引</div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">{message}</p>
        <p className="mono mt-3 text-[11px] text-[var(--color-ink-faint)]">
          {desktop ? "在顶栏的仓库菜单里重新扫描，或添加其他仓库" : "先运行 repolens scan <仓库路径>"}
        </p>
      </div>
    </div>
  );
}

function BootSkeleton() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-[12px] text-[var(--color-ink-faint)]">正在读取索引…</div>
    </div>
  );
}
