import type { GraphNodeDto } from "@repolens/core/types";
import { useEffect, useRef } from "react";
import { ALT_KEY } from "../lib/shortcut";
import { useAppStore } from "../store/useAppStore";
import { canAttachNode, nodeAttachment, useChatStore } from "../store/useChatStore";

export interface ContextMenuState {
  node: GraphNodeDto;
  x: number;
  y: number;
}

interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * 右键菜单。
 *
 * 「隐藏」策略里明确要放到这里的高级操作——它们都有价值，但都不是
 * 高频操作，摆在界面上只会稀释主路径。
 */
export function NodeContextMenu({ state, onClose }: { state: ContextMenuState; onClose: () => void }) {
  const store = useAppStore();
  const ref = useRef<HTMLDivElement>(null);
  const { node } = state;

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const isFocused = store.focus === node.id;
  const isExpanded = store.expanded.includes(node.id);

  const items: MenuItem[] = [
    {
      label: isExpanded ? "收起子项" : "展开子项",
      hint: "双击",
      disabled: !node.expandable,
      run: () => void store.toggleExpand(node),
    },
    {
      label: isFocused ? "退出聚焦" : "以此为中心聚焦",
      hint: `${ALT_KEY}双击`,
      run: () => store.setFocus(isFocused ? null : node.id),
    },
    {
      label: "聚焦范围 +1 层",
      disabled: !isFocused,
      run: () => store.setFocus(node.id, Math.min(4, store.focusDepth + 1)),
    },
    {
      label: "隐藏此枝",
      run: () => {
        store.hideBranch(node.id);
        onClose();
      },
    },
    {
      label: "查看详情",
      hint: "单击",
      run: () => store.select(node.id),
    },
    {
      label: "加入 AI 对话",
      disabled: !canAttachNode(node.id),
      run: () => useChatStore.getState().attach(nodeAttachment(node.id, node.label)),
    },
    {
      label: "复制路径",
      disabled: !node.path,
      run: () => {
        if (node.path) void navigator.clipboard.writeText(node.path);
      },
    },
  ];

  const left = Math.min(state.x, window.innerWidth - 210);
  const top = Math.min(state.y, window.innerHeight - items.length * 30 - 20);

  return (
    <div
      ref={ref}
      className="anim-fade fixed z-50 w-[196px] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] py-1 shadow-2xl"
      style={{ left, top }}
    >
      <div className="mono truncate border-b border-[var(--color-line)] px-3 pb-1.5 pt-0.5 text-[10px] text-[var(--color-ink-faint)]">
        {node.label}
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            item.run();
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:text-[var(--color-ink-faint)] disabled:hover:bg-transparent"
        >
          <span className="truncate">{item.label}</span>
          {item.hint && (
            <span className="ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
              {item.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
