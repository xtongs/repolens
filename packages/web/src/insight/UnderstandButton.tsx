import type { UnderstandingHow } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useUnderstandingStore } from "../store/useUnderstandingStore";

/**
 * 「我看懂了」。按内容指纹记账：代码一改，这条理解自动过期，按钮变成「重新看过」。
 * 模块（包、目录）记的是对外接口的指纹，内部怎么改都还算看懂了接口。
 */
export function UnderstandButton({
  nodeId,
  how = "manual",
  compact = false,
}: {
  nodeId: string;
  how?: UnderstandingHow;
  compact?: boolean;
}) {
  const t = useT();
  const value = useUnderstandingStore((s) => s.marks[nodeId]);
  const version = useUnderstandingStore((s) => s.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = /^(?:pkg|dir):/.test(nodeId);

  useEffect(() => {
    void useUnderstandingStore.getState().track([nodeId]);
  }, [nodeId, version]);

  const run = (action: "mark" | "unmark") => {
    setBusy(true);
    setError(null);
    const store = useUnderstandingStore.getState();
    void (action === "mark" ? store.mark(nodeId, how) : store.unmark(nodeId))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const mark = value?.mark ?? null;
  const viaFile = nodeId.startsWith("sym:") && value?.key?.startsWith("path:") === true;
  const base = `shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] transition-colors disabled:cursor-wait disabled:opacity-60 ${
    compact ? "" : "leading-4"
  }`;

  if (mark === "understood") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => run("unmark")}
          title={viaFile ? t("随整个文件一起标过；点一下撤销文件那条标记") : t("点一下撤销")}
          className={`${base} border-[var(--color-success)]/40 text-[var(--color-success)] hover:bg-[var(--color-success)]/10`}
        >
          ✓ {scope ? t("看懂了接口") : t("看懂了")}
          {viaFile && !compact && <span className="ml-1 opacity-70">{t("（随文件）")}</span>}
        </button>
        {error && <span className="text-[10px] text-[var(--color-warn)]">{error}</span>}
      </span>
    );
  }

  if (mark === "stale") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => run("mark")}
          title={scope ? t("看懂之后对外接口变了，重新看过再标") : t("看懂之后代码被改过，重新看过再标")}
          className={`${base} border-[var(--color-warn)]/50 text-[var(--color-warn)] hover:bg-[var(--color-warn)]/10`}
        >
          ↻ {compact ? t("又改过") : t("改过了 · 重新看过")}
        </button>
        {error && <span className="text-[10px] text-[var(--color-warn)]">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={busy || value === undefined}
        onClick={() => run("mark")}
        title={scope
          ? t("记下你看懂了它的对外接口；接口变了会提醒你重新看")
          : t("记下你看懂了它；代码改了会提醒你重新看")}
        className={`${base} border-[var(--color-line-strong)] text-[var(--color-ink-muted)] hover:border-[var(--color-success)] hover:text-[var(--color-success)]`}
      >
        {scope ? t("我看懂了接口") : t("我看懂了")}
      </button>
      {error && <span className="text-[10px] text-[var(--color-warn)]">{error}</span>}
    </span>
  );
}
