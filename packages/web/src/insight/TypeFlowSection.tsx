import type { FlowRefDto, TypeFlowDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { RowButton, Section } from "../ui/panel";

const TYPE_KINDS = new Set(["class", "interface", "struct", "type", "enum", "trait"]);

export function isTypeKind(kind: string): boolean {
  return TYPE_KINDS.has(kind);
}

/**
 * 一个类型在代码里怎么流动：谁创建它、谁返回它、谁接收它、谁实现它。
 * 读懂核心数据结构的去向，比逐个读用到它的函数快得多。
 */
export function TypeFlowSection({ nodeId }: { nodeId: string }) {
  const t = useT();
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [flow, setFlow] = useState<TypeFlowDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFlow(null);
    // 类型流只是补充，取不到就不显示
    void api.typeFlow(nodeId).then((result) => !cancelled && setFlow(result)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nodeId, indexRevision]);

  if (!flow) return null;
  const empty = flow.creators.length + flow.producers.length + flow.consumers.length + flow.implementers.length === 0;

  return (
    <Section
      title={t("它在代码里怎么流动")}
      aside={<span className="text-[10px] text-[var(--color-ink-faint)]">{t("{count} 个文件 import 它", { count: flow.importers })}</span>}
    >
      {empty ? (
        <p className="text-[11px] text-[var(--color-ink-faint)]">{t("没有函数在签名里用到它，也没有地方创建它")}</p>
      ) : (
        <div className="space-y-2">
          <FlowList title={t("创建它")} refs={flow.creators} />
          <FlowList title={t("返回它")} refs={flow.producers} />
          <FlowList title={t("接收它")} refs={flow.consumers} />
          <FlowList title={t("实现或继承它")} refs={flow.implementers} />
        </div>
      )}
    </Section>
  );
}

function FlowList({ title, refs }: { title: string; refs: FlowRefDto[] }) {
  const select = useAppStore((s) => s.select);
  if (refs.length === 0) return null;
  return (
    <div>
      <div className="text-[10.5px] text-[var(--color-ink-faint)]">
        {title} <span className="tabular-nums">({refs.length})</span>
      </div>
      <div className="mt-0.5 space-y-0.5">
        {refs.map((ref) => (
          <RowButton key={`${ref.id}:${ref.line}`} onClick={() => select(ref.id)} meta={`${ref.path.split("/").at(-1)}:${ref.line}`} title={ref.detail ?? undefined}>
            <span className="mono truncate text-[11px] text-[var(--color-ink)]">{ref.name}</span>
            {ref.detail && <span className="mono truncate text-[10px] text-[var(--color-ink-faint)]">{ref.detail}</span>}
          </RowButton>
        ))}
      </div>
    </div>
  );
}
