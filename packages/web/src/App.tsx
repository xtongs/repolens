import { useEffect } from "react";
import { GraphCanvas } from "./graph/GraphCanvas";
import { DetailDrawer } from "./layout/DetailDrawer";
import { TopBar } from "./layout/TopBar";
import { TreePanel } from "./layout/TreePanel";
import { CommandPalette } from "./overlays/CommandPalette";
import { HelpSheet } from "./overlays/HelpSheet";
import { useAppStore } from "./store/useAppStore";

export function App() {
  const boot = useAppStore((s) => s.boot);
  const bootError = useAppStore((s) => s.bootError);
  const overview = useAppStore((s) => s.overview);
  const escape = useAppStore((s) => s.escape);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        escape();
        return;
      }
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escape, setPaletteOpen]);

  if (bootError !== null) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-[14px] font-medium">无法加载索引</div>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
            {bootError}
          </p>
          <p className="mono mt-3 text-[11px] text-[var(--color-ink-faint)]">
            先运行 repolens scan &lt;仓库路径&gt;
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />

      <main className="relative flex-1 overflow-hidden">
        {overview === null ? <BootSkeleton /> : <GraphCanvas />}
        <TreePanel />
        <DetailDrawer />
      </main>

      <CommandPalette />
      <HelpSheet />
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
