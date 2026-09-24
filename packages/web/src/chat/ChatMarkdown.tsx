import { memo, useEffect, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeLine } from "../code/CodeLines";
import { shikiLanguage, useHighlightedLines } from "../lib/highlight";
import { useAppStore } from "../store/useAppStore";
import { canAttachNode } from "../store/useChatStore";

/** 只取 react-markdown 传进来的 hast 节点里用得到的字段，不引入 hast 类型包 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * AI 回答的渲染。
 *
 * 回答里的 `[名称](node:ID)` 是模型按提示词引用的上下文节点：渲染成可点的
 * 节点标签，悬停时在画布上高亮并浮出预览卡片，点击直接定位过去——回答
 * 和画布始终连在一起，而不是一段需要人自己去图上找的文字。
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  return (
    <div className="chat-markdown text-[12px] leading-relaxed text-[var(--color-ink)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={streaming ? STREAMING_COMPONENTS : COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

function urlTransform(url: string): string {
  return url.startsWith("node:") ? url : defaultUrlTransform(url);
}

// 两套组件共用同一个 a / code，流式结束切换时节点链接不会整体重新挂载
const link: Components["a"] = ({ href, children }) => {
  if (href?.startsWith("node:")) return <NodeLink id={href.slice(5)}>{children}</NodeLink>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline-offset-2 hover:underline">
      {children}
    </a>
  );
};

const inlineCode: Components["code"] = ({ children }) => (
  <code className="mono rounded bg-[var(--color-surface-3)] px-1 py-px text-[0.92em] text-[var(--color-ink)]">
    {children}
  </code>
);

function buildComponents(streaming: boolean): Components {
  return {
    a: link,
    code: inlineCode,
    pre({ node }) {
      const code = (node as unknown as HastNode | undefined)?.children?.find(
        (child) => child.type === "element" && child.tagName === "code",
      );
      const classes = code?.properties?.["className"];
      const lang = Array.isArray(classes)
        ? classes.map(String).find((name) => name.startsWith("language-"))?.slice("language-".length) ?? null
        : null;
      return <ChatCodeBlock code={code ? textOf(code).replace(/\n$/, "") : ""} lang={lang} highlight={!streaming} />;
    },
  };
}

const COMPONENTS = buildComponents(false);
/** 流式输出时代码块每个字都在变，先按纯文本渲染，写完再高亮 */
const STREAMING_COMPONENTS = buildComponents(true);

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function NodeLink({ id, children }: { id: string; children: ReactNode }) {
  const reveal = useAppStore((s) => s.reveal);
  const hover = useAppStore((s) => s.hover);
  // 悬停中被卸载（Esc 收起对话、关掉详情）时收不到 mouseleave，画布会一直停在高亮态
  useEffect(() => () => {
    if (useAppStore.getState().hovered === id) useAppStore.getState().hover(null);
  }, [id]);
  if (!canAttachNode(id)) return <span className="text-[var(--color-accent)]">{children}</span>;
  return (
    <button
      type="button"
      title="在画布上定位"
      onClick={() => {
        hover(null);
        void reveal(id);
      }}
      onMouseEnter={(event) => {
        // 预览卡片放在侧栏左边的画布上，不压住正在读的回答
        const left = event.currentTarget.closest("aside")?.getBoundingClientRect().left ?? event.clientX;
        hover(id, { x: left - 4, y: event.currentTarget.getBoundingClientRect().top });
      }}
      onMouseLeave={() => hover(null)}
      className="mx-px inline rounded bg-[var(--color-accent)]/10 px-1 text-left text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20"
    >
      {children}
    </button>
  );
}

function ChatCodeBlock({ code, lang, highlight }: { code: string; lang: string | null; highlight: boolean }) {
  const shiki = shikiLanguage(lang);
  const tokens = useHighlightedLines(highlight ? code : null, shiki);
  const lines = code.split("\n");
  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)]/60">
      {lang && (
        <div className="mono border-b border-[var(--color-line)] px-2.5 py-0.5 text-[9.5px] text-[var(--color-ink-faint)]">
          {lang}
        </div>
      )}
      <div className="thin-scroll overflow-x-auto">
        <div className="w-max min-w-full py-1.5 pl-2.5">
          {lines.map((line, index) => (
            <CodeLine key={index} number={null} text={line} tokens={tokens?.[index]} />
          ))}
        </div>
      </div>
    </div>
  );
}
