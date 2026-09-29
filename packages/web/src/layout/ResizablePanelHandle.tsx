import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { useT } from "../i18n";
import { readPref, writePref } from "../lib/prefs";

type PanelSide = "left" | "right";

interface ResizablePanelOptions {
  side: PanelSide;
  storageKey: string;
  /** 顶栏还没量到对齐位置时用这个宽度 */
  fallbackWidth: number;
  minWidth: number;
  maxWidth: number;
}

/**
 * 侧边栏没拖过时的宽度跟着顶栏走：左栏右缘对齐顶栏左侧那组按钮（最后一个是 AI 追问），
 * 右栏左缘对齐右侧操作区（第一个是「代码行」）。字号、语言、窗口宽度变了都会重新对齐。
 * 调用图和链路视图换掉了右侧那组控件，这时沿用上次量到的，免得切视图时抽屉跟着跳。
 */
const useSidebarAnchors = create<Record<PanelSide, number | null>>(() => ({ left: null, right: null }));

export function measureSidebarAnchors(header: HTMLElement): void {
  const box = header.getBoundingClientRect();
  const left = header.querySelector('[data-sidebar-anchor="left"]')?.getBoundingClientRect();
  const right = header.querySelector('[data-sidebar-anchor="right"]')?.getBoundingClientRect();
  const current = useSidebarAnchors.getState();
  const next = {
    left: left ? Math.round(left.right - box.left) : current.left,
    right: right ? Math.round(box.right - right.left) : current.right,
  };
  if (next.left !== current.left || next.right !== current.right) useSidebarAnchors.setState(next);
}

/**
 * 侧边栏宽度控制。拖拽只更新覆盖层本身，不触发画布重新布局。只有拖过的宽度才存成
 * 偏好，双击恢复默认就是清掉它，重新跟着顶栏对齐。
 */
export function useResizablePanel(options: ResizablePanelOptions) {
  const { side, storageKey, fallbackWidth, minWidth, maxWidth } = options;
  const anchored = useSidebarAnchors((s) => s[side]);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const clamp = useCallback(
    (value: number) => {
      const viewportMax = Math.max(minWidth, viewportWidth - 48);
      return Math.round(Math.min(Math.max(value, minWidth), Math.min(maxWidth, viewportMax)));
    },
    [maxWidth, minWidth, viewportWidth],
  );
  const [custom, setCustom] = useState(() => readStoredWidth(storageKey));
  const width = clamp(custom ?? anchored ?? fallbackWidth);
  const stopDraggingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    writePref(storageKey, custom === null ? null : String(custom));
  }, [storageKey, custom]);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => () => stopDraggingRef.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDraggingRef.current?.();

    const startX = event.clientX;
    const startWidth = width;
    const direction = side === "left" ? 1 : -1;
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      setCustom(clamp(startWidth + (moveEvent.clientX - startX) * direction));
    };
    const stop = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      document.documentElement.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      stopDraggingRef.current = null;
    };
    stopDraggingRef.current = stop;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }, [clamp, side, width]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "Home") next = minWidth;
    if (event.key === "End") next = maxWidth;
    if (event.key === "ArrowLeft") next = width + (side === "left" ? -16 : 16);
    if (event.key === "ArrowRight") next = width + (side === "left" ? 16 : -16);
    if (next === null) return;
    event.preventDefault();
    setCustom(clamp(next));
  }, [clamp, maxWidth, minWidth, side, width]);

  return {
    width,
    minWidth,
    maxWidth: clamp(maxWidth),
    onPointerDown,
    onKeyDown,
    reset: () => setCustom(null),
  };
}

function readStoredWidth(storageKey: string): number | null {
  const parsed = Number.parseFloat(readPref(storageKey) ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function ResizablePanelHandle({
  side,
  label,
  width,
  minWidth,
  maxWidth,
  onPointerDown,
  onKeyDown,
  onReset,
}: {
  side: PanelSide;
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title={t("拖动调整宽度；双击恢复默认")}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={`group absolute top-0 z-40 flex h-full w-2 touch-none cursor-col-resize items-center justify-center outline-none ${
        side === "left" ? "-right-1" : "-left-1"
      }`}
    >
      <span className="h-full w-px bg-transparent transition-colors group-hover:bg-[var(--color-accent)] group-focus:bg-[var(--color-accent)] group-active:bg-[var(--color-accent)]" />
    </div>
  );
}
