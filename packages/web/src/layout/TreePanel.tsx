import type { FindingDto, TreeNodeDto } from "@repolens/core/types";
import { useCallback, useEffect, useState } from "react";
import { type FindingsResponse, api } from "../api/client";
import { formatCount, languageColor } from "../lib/visual";
import { ALL_VISIBLE_ROLES, SOURCE_ONLY_ROLES, useAppStore } from "../store/useAppStore";

/**
 * 结构树。
 *
 * 覆盖在画布之上而不是挤压画布——布局抖动会让用户丢失在图上的视觉焦点，
 * 这个代价比多占一点空间大得多。
 */
export function TreePanel() {
  const open = useAppStore((s) => s.treeOpen);
  const setTreeOpen = useAppStore((s) => s.setTreeOpen);
  const tab = useAppStore((s) => s.panelTab);
  const setTab = useAppStore((s) => s.setPanelTab);

  if (!open) return null;

  return (
    <aside className="anim-slide-left absolute left-0 top-0 z-30 flex h-full w-[300px] flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-3">
        <PanelTab active={tab === "tree"} onClick={() => setTab("tree")} label="结构" />
        <PanelTab active={tab === "findings"} onClick={() => setTab("findings")} label="体检" />
        <button
          type="button"
          onClick={() => setTreeOpen(false)}
          className="ml-auto text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        >
          ×
        </button>
      </div>

      {tab === "tree" ? <TreeBody /> : <FindingsBody />}
    </aside>
  );
}

function PanelTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
        active
          ? "bg-[var(--color-surface-raised)] font-medium text-[var(--color-ink)]"
          : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
      }`}
    >
      {label}
    </button>
  );
}

function TreeBody() {
  const showNoise = useAppStore((s) => s.showNoise);
  const [root, setRoot] = useState<TreeNodeDto | null>(null);

  const roles = (showNoise ? ALL_VISIBLE_ROLES : SOURCE_ONLY_ROLES).join(",");

  useEffect(() => {
    let cancelled = false;
    void api
      .tree(".", 1, roles)
      .then((tree) => {
        if (!cancelled) setRoot(tree);
      })
      .catch(() => {
        if (!cancelled) setRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [roles]);

  return (
    <>
      <div className="shrink-0 px-3 pt-2 text-[10.5px] text-[var(--color-ink-faint)]">
        按代码行热力排序
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto py-1">
        {root === null ? (
          <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">加载中…</div>
        ) : (
          (root.children ?? []).map((child) => (
            <TreeRow key={child.id} node={child} depth={0} roles={roles} />
          ))
        )}
      </div>
    </>
  );
}

function TreeRow({ node, depth, roles }: { node: TreeNodeDto; depth: number; roles: string }) {
  const select = useAppStore((s) => s.select);
  const selected = useAppStore((s) => s.selected === node.id);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeNodeDto[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (node.kind === "file") return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children !== null) return;
    setLoading(true);
    try {
      const sub = await api.tree(node.path, 1, roles);
      setChildren(sub.children ?? []);
    } finally {
      setLoading(false);
    }
  }, [expanded, children, node.kind, node.path, roles]);

  const accent = node.kind === "file" ? languageColor(node.language) : "var(--color-ink-faint)";

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.kind === "directory" ? expanded : undefined}
        tabIndex={0}
        onClick={() => select(node.id)}
        onDoubleClick={() => void toggle()}
        onKeyDown={(event) => {
          if (event.key === "Enter") select(node.id);
          if (event.key === " ") {
            event.preventDefault();
            void toggle();
          }
        }}
        className={`group relative flex cursor-pointer items-center gap-1.5 py-[3px] pr-3 text-[12px] transition-colors ${
          selected ? "bg-[var(--color-surface-3)]" : "hover:bg-[var(--color-surface-2)]"
        }`}
        style={{ paddingLeft: 10 + depth * 13 }}
      >
        {/* 热力条：宽度即该项在同级中的相对体量，不占额外的行 */}
        <span
          className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--color-accent)]/8"
          style={{ width: `${Math.max(2, node.heat * 100)}%` }}
        />

        <span
          className="relative w-3 shrink-0 text-center text-[9px] text-[var(--color-ink-faint)]"
          onClick={(event) => {
            event.stopPropagation();
            void toggle();
          }}
        >
          {node.kind === "directory" ? (expanded ? "▾" : "▸") : ""}
        </span>

        <span className="relative h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />

        <span className="relative truncate text-[var(--color-ink)]">{node.name}</span>

        <span className="relative ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
          {formatCount(node.loc)}
        </span>
      </div>

      {expanded && loading && (
        <div
          className="py-1 text-[10.5px] text-[var(--color-ink-faint)]"
          style={{ paddingLeft: 26 + depth * 13 }}
        >
          加载中…
        </div>
      )}

      {expanded &&
        children?.map((child) => (
          <TreeRow key={child.id} node={child} depth={depth + 1} roles={roles} />
        ))}
    </>
  );
}

/**
 * 体检清单。
 *
 * 刻意不做成弹窗或独立页面：它是一份「该去看哪里」的待办，和结构树是同一类
 * 导航物件，所以复用同一个面板槽位做标签页，不新增门面。
 *
 * 一条结论只列一次（服务端按 group_key 去重），点击落到图上对应节点。
 */
function FindingsBody() {
  const [data, setData] = useState<FindingsResponse | null>(null);
  const [kind, setKind] = useState<"all" | "duplicate" | "cycle">("all");
  const reveal = useAppStore((s) => s.reveal);
  const selected = useAppStore((s) => s.selected);

  useEffect(() => {
    let cancelled = false;
    void api
      .findings(kind === "all" ? undefined : kind)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  if (data === null) {
    return <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">加载中…</div>;
  }

  if (data.summary.total === 0) {
    return (
      <div className="px-3 py-4 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
        没有发现结构问题。
        <br />
        当前检查项：跨文件的重复实现、同级作用域之间的循环依赖。
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-3 pt-2">
        <FilterChip active={kind === "all"} onClick={() => setKind("all")}>
          全部 {data.summary.total}
        </FilterChip>
        <FilterChip active={kind === "duplicate"} onClick={() => setKind("duplicate")}>
          重复 {data.summary.byKind["duplicate"] ?? 0}
        </FilterChip>
        <FilterChip active={kind === "cycle"} onClick={() => setKind("cycle")}>
          循环 {data.summary.byKind["cycle"] ?? 0}
        </FilterChip>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto py-1">
        {data.items.map((item) => (
          <button
            key={item.groupKey}
            type="button"
            onClick={() => void reveal(item.scopeKey)}
            title={item.detail}
            className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-raised)] ${
              selected === item.scopeKey ? "bg-[var(--color-surface-raised)]" : ""
            }`}
          >
            <div className="flex items-baseline gap-1.5">
              <span
                className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: severityColor(item.severity) }}
              />
              <span className="truncate text-[11.5px] text-[var(--color-ink)]">{item.title}</span>
            </div>
            <div className="mono truncate-start ml-3 truncate text-[10px] text-[var(--color-ink-faint)]">
              {item.path}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
        active
          ? "bg-[var(--color-accent)]/18 text-[var(--color-accent)]"
          : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

function severityColor(severity: FindingDto["severity"]): string {
  if (severity === "high") return "var(--color-danger)";
  if (severity === "medium") return "var(--color-warn)";
  return "var(--color-ink-faint)";
}
