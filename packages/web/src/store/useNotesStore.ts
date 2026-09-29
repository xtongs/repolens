import type { NoteDto, NoteInputDto } from "@repolens/core/types";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../api/client";
import { useAppStore } from "./useAppStore";

interface NotesState {
  notes: NoteDto[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load: () => Promise<void>;
  add: (input: NoteInputDto) => Promise<NoteDto>;
  remove: (id: string) => Promise<void>;
}

/** 换仓库时递增，让还在路上的旧仓库请求落地后不再写回 */
let generation = 0;

export const useNotesStore = create<NotesState>((set) => ({
  notes: [],
  status: "idle",
  error: null,

  async load() {
    const current = generation;
    set({ status: "loading", error: null });
    try {
      const { notes } = await api.notes();
      if (current === generation) set({ notes, status: "ready" });
    } catch (err) {
      if (current === generation) set({ status: "error", error: (err as Error).message });
    }
  },

  async add(input) {
    const current = generation;
    const note = await api.addNote(input);
    if (current === generation) set((state) => ({ notes: [...state.notes, note] }));
    return note;
  },

  async remove(id) {
    const current = generation;
    await api.deleteNote(id);
    if (current === generation) set((state) => ({ notes: state.notes.filter((note) => note.id !== id) }));
  },
}));

// 重扫之后文件 id 会变，笔记里换算好的 nodeId 也得跟着重取
useAppStore.subscribe((state, previous) => {
  if (state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision) {
    generation++;
    useNotesStore.setState({ notes: [], status: "idle", error: null });
  }
});

/** 第一次用到或换仓库之后才去取 */
export function useNotes(): NoteDto[] {
  const notes = useNotesStore((s) => s.notes);
  const status = useNotesStore((s) => s.status);
  useEffect(() => {
    if (status === "idle") void useNotesStore.getState().load();
  }, [status]);
  return notes;
}

export function notesOnFile(notes: NoteDto[], path: string): NoteDto[] {
  return notes.filter((note) => note.target.kind === "file" && note.target.path === path);
}

/** 行号和 [from, to] 有交集的笔记；不带行号的整文件笔记不算 */
export function notesInRange(notes: NoteDto[], path: string, from: number, to: number): NoteDto[] {
  return notes.filter((note) => {
    const lines = note.target.kind === "file" && note.target.path === path ? note.target.lines : null;
    return lines !== null && lines[0] <= to && lines[1] >= from;
  });
}

/** 挂在这个目录或包上的笔记；目录还带上它下面文件的笔记 */
export function notesOnScope(notes: NoteDto[], scopeId: string): NoteDto[] {
  const dir = scopeId.startsWith("dir:") ? scopeId.slice(4) : null;
  return notes.filter((note) => {
    if (note.target.kind === "scope") return note.target.id === scopeId;
    if (dir === null) return false;
    return dir === "." || note.target.path.startsWith(`${dir}/`);
  });
}

export function formatLines(lines: [number, number]): string {
  return lines[0] === lines[1] ? `L${lines[0]}` : `L${lines[0]}–${lines[1]}`;
}

/** 跳到笔记所在的位置：有行号就打开源码并定位，否则打开详情的笔记页签 */
export function openNote(note: NoteDto): void {
  if (note.nodeId === null) return;
  const lines = note.target.kind === "file" ? note.target.lines : null;
  useAppStore.getState().openDetail(note.nodeId, lines ? { tab: "source", lines } : { tab: "notes", lines: null });
}
