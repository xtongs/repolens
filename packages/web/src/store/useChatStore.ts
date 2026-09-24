import type { ChatContextItemDto, ChatMessageDto, ChatRefDto } from "@repolens/core/types";
import { create } from "zustand";
import { api } from "../api/client";
import { useAppStore, type AppState } from "./useAppStore";

/** 服务端接受的节点 id；聚合节点、外部依赖这类合成节点没有可读的内容 */
const CHAT_NODE_ID = /^(?:(?:sym|file):\d+|(?:dir|pkg):.+)$/;

export type ChatAttachment =
  | { key: string; kind: "node"; id: string; label: string }
  | {
      key: string;
      kind: "quote";
      text: string;
      nodeId: string | null;
      lines: [number, number] | null;
      label: string;
    }
  | { key: string; kind: "view"; ref: Extract<ChatRefDto, { kind: "view" }>; label: string };

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** 用户消息发出时附带的上下文，用于回显成 chip */
  attachments: ChatAttachment[];
  /** 服务端实际放进提示词的上下文，只有助手消息有 */
  context: ChatContextItemDto[] | null;
  status: "streaming" | "done" | "error" | "stopped";
  error: string | null;
}

interface ChatState {
  messages: ChatMessage[];
  /** 用户手动加进来、还没发出去的附件 */
  attachments: ChatAttachment[];
  /**
   * 当前选中项会自动作为附件。用户把它摘掉后，同一个节点不再自动加回；
   * 换了选中项自然恢复。
   */
  dismissedAuto: string | null;
  includeView: boolean;
  streaming: boolean;
  draft: string;
  /** 递增即请求输入框获得焦点 */
  focusNonce: number;
  /** 详情加载后记下的节点名，给不在画布上的节点一个像样的 chip 名字 */
  labels: Record<string, string>;

  open: (focus?: boolean) => void;
  rememberLabel: (id: string, label: string) => void;
  attach: (attachment: ChatAttachment) => void;
  detach: (key: string) => void;
  dismissAuto: (nodeId: string) => void;
  setIncludeView: (value: boolean) => void;
  setDraft: (value: string) => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
  retry: () => Promise<void>;
  clear: () => void;
}

let controller: AbortController | null = null;
let nextId = 1;

export const useChatStore = create<ChatState>((set, get) => {
  const patch = (id: number, update: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...(typeof update === "function" ? update(message) : update) } : message,
      ),
    }));

  const run = async (assistantId: number) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    set({ streaming: true });

    const history: ChatMessageDto[] = get()
      .messages.filter((message) => message.id < assistantId)
      // 失败或被中止、一个字都没有的回答不回放给模型
      .filter((message) => message.role === "user" || message.content.trim() !== "")
      .map((message) => ({
        role: message.role,
        content: message.content,
        refs: message.role === "user" ? message.attachments.map(toRef) : null,
      }));

    try {
      await api.chat(
        { messages: history },
        {
          onContext: (items) => patch(assistantId, { context: items }),
          onDelta: (text) => patch(assistantId, (message) => ({ content: message.content + text })),
        },
        current.signal,
      );
      patch(assistantId, { status: "done" });
    } catch (err) {
      if (current.signal.aborted) patch(assistantId, { status: "stopped" });
      else patch(assistantId, { status: "error", error: (err as Error).message });
    } finally {
      if (controller === current) {
        controller = null;
        set({ streaming: false });
      }
    }
  };

  return {
    messages: [],
    attachments: [],
    dismissedAuto: null,
    includeView: true,
    streaming: false,
    draft: "",
    focusNonce: 0,
    labels: {},

    open(focus = true) {
      useAppStore.getState().setChatOpen(true);
      if (focus) set((state) => ({ focusNonce: state.focusNonce + 1 }));
    },

    rememberLabel(id, label) {
      if (get().labels[id] === label) return;
      set((state) => ({ labels: { ...state.labels, [id]: label } }));
    },

    attach(attachment) {
      set((state) => ({
        attachments: state.attachments.some((item) => item.key === attachment.key)
          ? state.attachments
          : [...state.attachments, attachment],
      }));
      get().open();
    },

    detach(key) {
      set((state) => ({ attachments: state.attachments.filter((item) => item.key !== key) }));
    },

    dismissAuto(nodeId) {
      set({ dismissedAuto: nodeId });
    },

    setIncludeView(value) {
      set({ includeView: value });
    },

    setDraft(value) {
      set({ draft: value });
    },

    async send(text) {
      const content = text.trim();
      if (content === "" || get().streaming) return;
      const attachments = pendingAttachments(get(), useAppStore.getState());
      const user: ChatMessage = {
        id: nextId++, role: "user", content, attachments, context: null, status: "done", error: null,
      };
      const assistant: ChatMessage = {
        id: nextId++, role: "assistant", content: "", attachments: [], context: null, status: "streaming", error: null,
      };
      set((state) => ({ messages: [...state.messages, user, assistant], attachments: [], draft: "" }));
      await run(assistant.id);
    },

    stop() {
      controller?.abort();
    },

    async retry() {
      const last = get().messages.at(-1);
      if (!last || last.role !== "assistant" || get().streaming) return;
      patch(last.id, { content: "", context: null, status: "streaming", error: null });
      await run(last.id);
    },

    clear() {
      controller?.abort();
      controller = null;
      set({ messages: [], attachments: [], streaming: false, dismissedAuto: null });
    },
  };
});

// 对话里的节点 id 属于某个仓库、某次扫描；换仓库或重扫后全部作废
useAppStore.subscribe((state, previous) => {
  if (state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision) {
    useChatStore.getState().clear();
    useChatStore.setState({ labels: {} });
  }
});

/** 决定自动附件的那部分画布状态 */
export type ChatViewState = Pick<
  AppState,
  "selected" | "subgraphs" | "expanded" | "rootScope" | "callGraph" | "traceId" | "traceLabel"
>;

/** 发送时实际附带的上下文：自动附件在前，手动附件在后，按 key 去重。 */
export function pendingAttachments(chat: ChatState, app: ChatViewState): ChatAttachment[] {
  const auto = autoAttachments(chat, app);
  const seen = new Set<string>();
  return [...auto, ...chat.attachments].filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

export function autoAttachments(
  chat: Pick<ChatState, "dismissedAuto" | "includeView" | "labels">,
  app: ChatViewState,
): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  const selected = app.selected;
  if (selected && selected !== chat.dismissedAuto && CHAT_NODE_ID.test(selected)) {
    out.push(nodeAttachment(selected, nodeLabel(app, selected, chat.labels)));
  }
  if (chat.includeView) out.push(viewAttachment(app));
  return out;
}

export function nodeAttachment(id: string, label: string): ChatAttachment {
  return { key: `node:${id}`, kind: "node", id, label };
}

export function canAttachNode(id: string): boolean {
  return CHAT_NODE_ID.test(id);
}

function viewAttachment(app: ChatViewState): ChatAttachment {
  if (app.traceId) {
    return {
      key: "view",
      kind: "view",
      ref: { kind: "view", mode: "trace", traceId: app.traceId },
      label: `链路 · ${app.traceLabel ?? app.traceId}`,
    };
  }
  if (app.callGraph) {
    return {
      key: "view",
      kind: "view",
      ref: { kind: "view", mode: "callgraph", scope: app.callGraph.scopeId },
      label: `调用图 · ${app.callGraph.label}`,
    };
  }
  // 最近展开的层级最能说明用户在看哪儿，服务端只取前几个
  const expanded = [...app.expanded].reverse().filter((id) => CHAT_NODE_ID.test(id));
  return {
    key: "view",
    kind: "view",
    ref: { kind: "view", mode: "structure", scope: app.rootScope, expanded },
    label: expanded.length > 0 ? `结构图 · 展开 ${expanded.length} 层` : "结构图 · 仓库根",
  };
}

/** 优先用详情里的全名，其次是画布上的节点名，都没有时退回 id 末段 */
export function nodeLabel(
  app: Pick<AppState, "subgraphs">,
  id: string,
  labels: Record<string, string> = {},
): string {
  const remembered = labels[id];
  if (remembered) return remembered;
  for (const graph of Object.values(app.subgraphs)) {
    const node = graph.nodes.find((item) => item.id === id);
    if (node) return node.label;
  }
  if (id.startsWith("dir:") || id.startsWith("pkg:")) return id.slice(4).split("/").at(-1) || id;
  return id.startsWith("sym:") ? "符号" : "文件";
}

function toRef(attachment: ChatAttachment): ChatRefDto {
  if (attachment.kind === "node") return { kind: "node", id: attachment.id };
  if (attachment.kind === "view") return attachment.ref;
  return { kind: "quote", text: attachment.text, nodeId: attachment.nodeId, lines: attachment.lines };
}
