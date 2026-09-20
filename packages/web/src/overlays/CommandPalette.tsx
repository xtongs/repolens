import type { SearchHitDto } from "@repolens/core/types";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { ALL_VISIBLE_ROLES, SOURCE_ONLY_ROLES, useAppStore } from "../store/useAppStore";

const KIND_LABELS: Record<string, string> = {
  file: "文件",
  symbol: "符号",
  package: "包",
  directory: "目录",
};

/**
 * ⌘K 命令面板。
 *
 * 「组织」策略要求所有「我想去某处」的意图收到一个入口，
 * 而不是在界面上散落十几个跳转按钮。
 */
export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const reveal = useAppStore((s) => s.reveal);
  const showNoise = useAppStore((s) => s.showNoise);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHitDto[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setCursor(0);
      // 等抽屉挂载完再聚焦，否则 autoFocus 会被动画吃掉
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      return;
    }
    // 输入防抖：搜索走 FTS，快但没必要每个键都打一次
    const timer = window.setTimeout(() => {
      void api
        // 搜索要和图谱用同一套噪音规则，否则图上刻意藏掉的测试文件
        // 会从搜索结果里涌回来，前 20 条几乎全是 *.test.ts
        .search(trimmed, 24, (showNoise ? ALL_VISIBLE_ROLES : SOURCE_ONLY_ROLES).join(","))
        .then((result) => {
          setHits(result);
          setCursor(0);
        })
        .catch(() => setHits([]));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query, open, showNoise]);

  if (!open) return null;

  const commit = (hit: SearchHitDto | undefined) => {
    if (!hit) return;
    // 走 reveal 而不是裸 select：否则图停在原地，搜到的东西只出现在抽屉里，
    // 人还得自己一层层下钻回去找它在结构里的位置
    void reveal(hit.id);
    setOpen(false);
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-start justify-center bg-[var(--color-overlay)] pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((c) => Math.min(hits.length - 1, c + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (event.key === "Enter") {
              commit(hits[cursor]);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="搜索文件、符号、包…"
          className="w-full border-b border-[var(--color-line)] bg-transparent px-4 py-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />

        <div className="thin-scroll max-h-[52vh] overflow-y-auto py-1">
          {hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11.5px] text-[var(--color-ink-faint)]">
              {query.trim().length === 0 ? "输入关键词开始搜索" : "没有匹配项"}
            </div>
          ) : (
            hits.map((hit, index) => (
              <button
                key={hit.id}
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => commit(hit)}
                className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition-colors ${
                  index === cursor ? "bg-[var(--color-surface-3)]" : ""
                }`}
              >
                <span className="w-7 shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">
                  {KIND_LABELS[hit.kind] ?? hit.kind}
                </span>
                {/*
                  收缩优先级：名字是主标识，路径是辅助信息，所以让路径先让位。
                  反过来（给路径 shrink-0）会把一串 agent-session-*.ts 全截成
                  `agent-sess…`，而右边的路径反倒完整显示。
                */}
                <span className="mono max-w-[58%] shrink-0 truncate text-[12px] text-[var(--color-ink)]">
                  {hit.label}
                </span>
                <Detail text={hit.detail} />
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-1.5 text-[10px] text-[var(--color-ink-faint)]">
          <span>↑↓ 选择</span>
          <span>⏎ 打开详情</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 搜索结果右侧的辅助信息，形如 `interface · packages/a/src/b.ts`。
 *
 * 路径从头部截断而不是末尾：monorepo 里同一次搜索命中的行往往共享
 * `packages/x/src/` 前缀，省略号放在末尾就把唯一能区分它们的尾段砍掉了。
 * 前缀里的符号种类另外渲染，否则它会被一起截掉。
 */
function Detail({ text }: { text: string }) {
  const cut = text.lastIndexOf(" · ");
  const kind = cut === -1 ? null : text.slice(0, cut);
  const path = cut === -1 ? text : text.slice(cut + 3);

  return (
    <span className="ml-auto flex min-w-0 items-baseline gap-1.5 pl-3 text-[10px] text-[var(--color-ink-faint)]">
      {kind && <span className="shrink-0">{kind}</span>}
      <span className="mono truncate-start min-w-0">{path}</span>
    </span>
  );
}
