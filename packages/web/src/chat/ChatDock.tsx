import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Chevron } from "../code/Chevron";
import { desktop } from "../lib/desktop";
import { modKey } from "../lib/shortcut";
import { useAppStore } from "../store/useAppStore";
import {
  autoAttachments,
  useChatStore,
  type ChatAttachment,
  type ChatMessage,
} from "../store/useChatStore";

// Markdown 解析只在第一次出现回答时才需要，不进首屏包
const ChatMarkdown = lazy(() => import("./ChatMarkdown").then((module) => ({ default: module.ChatMarkdown })));

const HEIGHT_STORAGE_KEY = "repolens:chat-height";
const DEFAULT_HEIGHT = 340;
const MIN_HEIGHT = 180;
/** 对话展开时，上方详情至少留这么高，不至于被挤成一条标签栏 */
const MIN_DETAIL_HEIGHT = 140;

/**
 * 追问 AI 面板，停靠在右侧栏底部。
 *
 * 放在详情下面而不是另开一个浮窗：问题几乎总是关于「正在看的这个东西」，
 * 上下文就在头顶，眼睛不用在画布两侧来回跳；画布也不会再被多挡一块。
 * 没有选中项时它独占侧栏。
 */
export function ChatDock({ detailVisible }: { detailVisible: boolean }) {
  const chatOpen = useAppStore((s) => s.chatOpen);
  const openChat = useChatStore((s) => s.open);
  const messageCount = useChatStore((s) => s.messages.length);
  const split = useSplitHeight(detailVisible && chatOpen);

  if (!chatOpen) {
    return (
      <button
        type="button"
        onClick={() => openChat()}
        className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--color-line)] px-3 text-left text-[11.5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-muted)]"
      >
        <span className="text-[var(--color-accent)]">✦</span>
        <span className="truncate">
          {messageCount > 0 ? `继续追问（${Math.ceil(messageCount / 2)} 轮对话）` : "追问 AI…"}
        </span>
        <kbd className="mono ml-auto shrink-0 text-[10px]">{modKey("I")}</kbd>
      </button>
    );
  }

  return (
    <section
      ref={split.ref}
      className="relative flex min-h-0 flex-col border-t border-[var(--color-line)] bg-[var(--color-surface)]"
      style={detailVisible ? { height: split.height, flexShrink: 0 } : { flex: 1 }}
    >
      {detailVisible && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整对话区高度"
          onPointerDown={split.onPointerDown}
          onDoubleClick={split.reset}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
        />
      )}
      <ChatHeader />
      <ChatThread />
      <ChatComposer />
    </section>
  );
}

function ChatHeader() {
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const clear = useChatStore((s) => s.clear);
  const hasMessages = useChatStore((s) => s.messages.length > 0);
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-line)] pl-3 pr-1.5">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-accent)]">追问 AI</span>
      <div className="ml-auto flex items-center gap-0.5">
        {hasMessages && (
          <button
            type="button"
            onClick={clear}
            className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink-muted)]"
          >
            新对话
          </button>
        )}
        <button
          type="button"
          onClick={() => setChatOpen(false)}
          title="收起（Esc）"
          aria-label="收起对话"
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
        >
          <Chevron open />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 对话记录
// ---------------------------------------------------------------------------

function ChatThread() {
  const messages = useChatStore((s) => s.messages);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // 用户往上翻看时不要把他拽回底部；停在底部附近时跟随新内容
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={ref}
      onScroll={(event) => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
      className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
    >
      {messages.length === 0 ? (
        <EmptyThread />
      ) : (
        <div className="space-y-3">
          {messages.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage key={message.id} message={message} last={message === messages.at(-1)} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function EmptyThread() {
  const selected = useAppStore((s) => s.selected);
  const callGraph = useAppStore((s) => s.callGraph !== null);
  const traceId = useAppStore((s) => s.traceId);
  const send = useChatStore((s) => s.send);
  const reason = useAppStore((s) => (s.overview?.llm && !(s.overview.llm.enabled && s.overview.llm.available)
    ? (s.overview.llm.reason ?? "扫描时未启用 AI")
    : null));

  const suggestions = traceId
    ? ["用一段话讲清这条链路在做什么", "数据在哪一步被改写或落盘？", "这条链路有哪些失败分支？"]
    : callGraph
      ? ["这些调用方分别在什么场景下调用它？", "改动它的签名会影响哪些地方？"]
      : selected?.startsWith("sym:")
        ? ["这个函数做了什么，为什么这样写？", "谁会调用它，在什么场景下？", "有哪些边界情况或潜在问题？"]
        : selected?.startsWith("file:")
          ? ["这个文件的职责是什么？", "应该从哪个函数开始读？", "它和哪些模块耦合最紧？"]
          : selected
            ? ["这个模块整体是怎么组织的？", "它对外暴露了哪些能力？", "从哪里开始读比较好？"]
            : ["这个仓库的整体架构是怎样的？", "主要入口在哪里？", "新人应该按什么顺序读代码？"];

  return (
    <div className="py-1">
      <p className="text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        AI 会读到下方标签里的上下文：选中节点的源码与关系、当前画布视图，以及你引用的片段。
        在详情里划选文字、或在伪代码步骤上点「追问」，都能把它加进来。
      </p>
      {reason && (
        <p className="mt-2 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/5 px-2 py-1.5 text-[10.5px] text-[var(--color-warn)]">
          AI 可能不可用：{reason}
          {desktop && (
            <button
              type="button"
              onClick={() => useAppStore.getState().setSettingsOpen(true)}
              className="ml-1.5 underline underline-offset-2 hover:text-[var(--color-ink)]"
            >
              去设置
            </button>
          )}
        </p>
      )}
      <div className="mt-2.5 flex flex-col items-start gap-1">
        {suggestions.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => void send(text)}
            className="rounded-md border border-[var(--color-line)] px-2 py-1 text-left text-[11px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-ink)]"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2">
      {message.attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {message.attachments.map((item) => (
            <AttachmentChip key={item.key} item={item} />
          ))}
        </div>
      )}
      <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-ink)]">{message.content}</div>
    </div>
  );
}

function AssistantMessage({ message, last }: { message: ChatMessage; last: boolean }) {
  const retry = useChatStore((s) => s.retry);
  const [showContext, setShowContext] = useState(false);
  const streaming = message.status === "streaming";

  return (
    <div className="pl-0.5">
      {message.content === "" && streaming ? (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-ink-faint)]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
          {message.context ? "正在思考…" : "正在读取上下文…"}
        </div>
      ) : (
        <Suspense
          fallback={<div className="whitespace-pre-wrap text-[12px] leading-relaxed">{message.content}</div>}
        >
          <ChatMarkdown content={message.content} streaming={streaming} />
        </Suspense>
      )}
      {streaming && message.content !== "" && (
        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-[var(--color-accent)] align-middle" />
      )}

      {message.status === "error" && (
        <div className="mt-1.5 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/5 px-2 py-1.5 text-[11px] text-[var(--color-warn)]">
          {message.error}
          {last && (
            <button type="button" onClick={() => void retry()} className="ml-2 underline-offset-2 hover:underline">
              重试
            </button>
          )}
        </div>
      )}

      {(message.context || message.status === "stopped") && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-[var(--color-ink-faint)]">
          {message.status === "stopped" && (
            <>
              <span>已停止</span>
              {last && (
                <button type="button" onClick={() => void retry()} className="hover:text-[var(--color-ink-muted)]">
                  重新回答
                </button>
              )}
            </>
          )}
          {message.context && (
            <button
              type="button"
              aria-expanded={showContext}
              onClick={() => setShowContext((value) => !value)}
              className="transition-colors hover:text-[var(--color-ink-muted)]"
            >
              依据 {message.context.length} 项上下文 {showContext ? "▾" : "▸"}
            </button>
          )}
        </div>
      )}
      {showContext && message.context && (
        <ul className="mt-1 space-y-0.5 border-l border-[var(--color-line)] pl-2">
          {message.context.map((item, index) => (
            <li key={index} className="flex gap-2 text-[10.5px]">
              <span className="truncate text-[var(--color-ink-muted)]">{item.label}</span>
              <span className="truncate text-[var(--color-ink-faint)]">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 输入框
// ---------------------------------------------------------------------------

function ChatComposer() {
  const app = useAppStore(
    useShallow((s) => ({
      selected: s.selected,
      subgraphs: s.subgraphs,
      expanded: s.expanded,
      rootScope: s.rootScope,
      callGraph: s.callGraph,
      traceId: s.traceId,
      traceLabel: s.traceLabel,
    })),
  );
  const chat = useChatStore(
    useShallow((s) => ({
      attachments: s.attachments,
      dismissedAuto: s.dismissedAuto,
      includeView: s.includeView,
      labels: s.labels,
      streaming: s.streaming,
      draft: s.draft,
      focusNonce: s.focusNonce,
      send: s.send,
      stop: s.stop,
      detach: s.detach,
      dismissAuto: s.dismissAuto,
      setIncludeView: s.setIncludeView,
      setDraft: s.setDraft,
    })),
  );
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textarea.current?.focus();
  }, [chat.focusNonce]);

  // 高度随内容长到六行左右，再多就在框内滚动
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [chat.draft]);

  const auto = autoAttachments(chat, app);
  const autoKeys = new Set(auto.map((item) => item.key));
  const manual = chat.attachments.filter((item) => !autoKeys.has(item.key));
  const canSend = chat.draft.trim() !== "" && !chat.streaming;

  const submit = () => {
    if (canSend) void chat.send(chat.draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-[var(--color-line)] p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {auto.map((item) => (
          <AttachmentChip
            key={item.key}
            item={item}
            auto
            onRemove={() => (item.kind === "view" ? chat.setIncludeView(false) : item.kind === "node" && chat.dismissAuto(item.id))}
          />
        ))}
        {manual.map((item) => (
          <AttachmentChip key={item.key} item={item} onRemove={() => chat.detach(item.key)} />
        ))}
        {!chat.includeView && (
          <button
            type="button"
            onClick={() => chat.setIncludeView(true)}
            className="rounded border border-dashed border-[var(--color-line)] px-1.5 py-px text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
          >
            + 当前视图
          </button>
        )}
      </div>
      <div className="flex items-end gap-1.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2 py-1.5 focus-within:border-[var(--color-accent)]/50">
        <textarea
          ref={textarea}
          rows={1}
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          className="thin-scroll min-h-[20px] flex-1 resize-none bg-transparent text-[12px] leading-[20px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
        {chat.streaming ? (
          <button
            type="button"
            onClick={chat.stop}
            className="shrink-0 rounded border border-[var(--color-line-strong)] px-2 py-0.5 text-[10.5px] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSend}
            onClick={submit}
            className="shrink-0 rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--color-canvas)] transition-opacity disabled:opacity-30"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

const CHIP_MARKERS: Record<ChatAttachment["kind"], string> = { node: "◇", quote: "❝", view: "▦" };

function AttachmentChip({
  item,
  auto = false,
  onRemove,
}: {
  item: ChatAttachment;
  auto?: boolean;
  onRemove?: () => void;
}) {
  const title = item.kind === "quote" ? item.text : item.kind === "node" ? item.id : undefined;
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px text-[10px] ${
        auto
          ? "border-[var(--color-line)] text-[var(--color-ink-faint)]"
          : "border-[var(--color-accent)]/40 text-[var(--color-accent)]"
      }`}
    >
      <span aria-hidden="true">{CHIP_MARKERS[item.kind]}</span>
      <span className="truncate">{item.label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除 ${item.label}`}
          className="-mr-0.5 px-0.5 opacity-60 transition-opacity hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 与详情区的分割
// ---------------------------------------------------------------------------

function useSplitHeight(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(readHeight);

  const clamp = (value: number) => {
    const parent = ref.current?.parentElement?.clientHeight ?? window.innerHeight;
    return Math.round(Math.min(Math.max(value, MIN_HEIGHT), Math.max(MIN_HEIGHT, parent - MIN_DETAIL_HEIGHT)));
  };

  // 窗口变矮时把对话区压回允许范围，避免把详情挤没
  useEffect(() => {
    if (!active) return;
    const onResize = () => setHeight((value) => clamp(value));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    let latest = startHeight;
    const onMove = (move: globalThis.PointerEvent) => {
      latest = clamp(startHeight + (startY - move.clientY));
      setHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      writeHeight(latest);
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const reset = () => {
    setHeight(clamp(DEFAULT_HEIGHT));
    writeHeight(DEFAULT_HEIGHT);
  };

  return { ref, height, onPointerDown, reset };
}

function readHeight(): number {
  try {
    const value = Number(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function writeHeight(value: number): void {
  try {
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(value));
  } catch {
    // 存储不可用时只影响下次打开的默认高度
  }
}
