import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type PanelSide = "left" | "right";

interface ResizablePanelOptions {
  side: PanelSide;
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

/**
 * 侧边栏宽度控制。拖拽只更新覆盖层本身，不触发画布重新布局；宽度保存在
 * localStorage，下一次打开页面时继续使用。
 */
export function useResizablePanel(options: ResizablePanelOptions) {
  const { side, storageKey, defaultWidth, minWidth, maxWidth } = options;
  const clamp = useCallback(
    (value: number) => {
      const viewportMax = typeof window === "undefined"
        ? maxWidth
        : Math.max(minWidth, window.innerWidth - 48);
      return Math.round(Math.min(Math.max(value, minWidth), Math.min(maxWidth, viewportMax)));
    },
    [maxWidth, minWidth],
  );
  const [width, setWidth] = useState(() => readStoredWidth(storageKey, defaultWidth, clamp));
  const stopDraggingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // 隐私模式或禁用存储时，当前会话内仍可正常调整。
    }
  }, [storageKey, width]);

  useEffect(() => {
    const fitViewport = () => setWidth((current) => clamp(current));
    window.addEventListener("resize", fitViewport);
    return () => window.removeEventListener("resize", fitViewport);
  }, [clamp]);

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
      setWidth(clamp(startWidth + (moveEvent.clientX - startX) * direction));
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
    setWidth(clamp(next));
  }, [clamp, maxWidth, minWidth, side, width]);

  return {
    width,
    minWidth,
    maxWidth: clamp(maxWidth),
    onPointerDown,
    onKeyDown,
    reset: () => setWidth(clamp(defaultWidth)),
  };
}

function readStoredWidth(
  storageKey: string,
  fallback: number,
  clamp: (value: number) => number,
): number {
  if (typeof window === "undefined") return clamp(fallback);
  try {
    const parsed = Number.parseFloat(window.localStorage.getItem(storageKey) ?? "");
    return clamp(Number.isFinite(parsed) ? parsed : fallback);
  } catch {
    return clamp(fallback);
  }
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
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整宽度；双击恢复默认"
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
