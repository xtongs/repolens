import { useAppStore } from "../store/useAppStore";

const GESTURES: Array<[string, string]> = [
  ["悬停", "节点放大并浮出预览卡片，高亮相连的边，无关节点淡出"],
  ["单击", "选中并打开右侧详情，不改变图的结构"],
  ["双击", "就地展开子项；已展开则收起"],
  ["⌥ 双击", "以此节点为中心，只看它的邻居"],
  ["右键", "聚焦、隐藏此枝、复制路径等高级操作"],
  ["拖拽", "微调节点位置"],
  ["滚轮", "缩放；缩得足够小时自动切换低细节渲染"],
  ["⌘K", "搜索文件、符号、包"],
  ["⌘I", "追问 AI：自动带上选中节点和当前视图；右键「加入 AI 对话」可再多带几个"],
  ["划选", "在详情里选中一段文字或源码，点浮出的「追问」把它作为引用"],
  ["Esc", "逐层退回：收起对话 → 关抽屉 → 取消选中 → 退出聚焦 → 恢复隐藏 → 收起全部"],
];

export function HelpSheet() {
  const open = useAppStore((s) => s.helpOpen);
  const setOpen = useAppStore((s) => s.setHelpOpen);

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[520px] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center border-b border-[var(--color-line)] px-4 py-2.5">
          <span className="text-[13px] font-medium">手势</span>
          <span className="ml-2 text-[10.5px] text-[var(--color-ink-faint)]">
            在任何视图、任何节点类型上含义都相同
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          >
            ×
          </button>
        </div>

        <div className="p-4">
          <table className="w-full">
            <tbody>
              {GESTURES.map(([gesture, description]) => (
                <tr key={gesture} className="align-top">
                  <td className="whitespace-nowrap py-1 pr-4 text-[11.5px] text-[var(--color-accent)]">
                    {gesture}
                  </td>
                  <td className="py-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
                    {description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 border-t border-[var(--color-line)] pt-2.5 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
            边的样式编码可信度：实线是解析器确定的依赖，虚线是名字匹配推断的，
            点线是有多个同名候选、默认不显示的。
          </div>
        </div>
      </div>
    </div>
  );
}
