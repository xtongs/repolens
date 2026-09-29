import { type ReactNode, useEffect, useRef } from "react";

/**
 * 侧栏顶部的页签条。英文页签比中文长得多，侧栏窄时放不下就横向滚动，
 * 不换行，也不把旁边的关闭按钮挤出去。
 *
 * scrollKey 变化时把当前页签（aria-pressed）滚进可见区——「在源码中定位」
 * 这类跳转切到的页签可能正滚在外面。
 */
export function TabStrip({ scrollKey, children }: { scrollKey: string; children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollKey]);

  return (
    <div
      ref={strip}
      onWheel={(event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
      }}
      className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap"
    >
      {children}
    </div>
  );
}
