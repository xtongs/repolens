import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";

/** 开着视角时，说明节点底边那条细条是什么意思 */
export function LensLegend() {
  const t = useT();
  const lens = useAppStore((s) => s.lens);
  if (lens === null) return null;

  const items = lens === "tests"
    ? [{ color: "var(--color-accent)", label: t("有测试走到的函数") }]
    : [{ color: "var(--color-danger)", label: t("近 90 天改得越勤越长") }];

  return (
    <div className="flex items-center gap-2.5 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)]/90 px-2.5 py-1 text-[10px] text-[var(--color-ink-faint)] shadow-sm backdrop-blur">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1">
          <span className="h-[3px] w-3 rounded-full" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}
