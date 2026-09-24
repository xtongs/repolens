import type { SourceSliceDto } from "@repolens/core/types";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { shikiLanguage, useHighlightedLines, type CodeToken } from "../lib/highlight";
import { useAppStore } from "../store/useAppStore";

export interface LoadedSource {
  slice: SourceSliceDto;
  lines: string[];
  tokens: CodeToken[][] | null;
  /** 取绝对行号 [from, to] 的原文，越界部分截掉 */
  range: (from: number, to: number) => { lines: string[]; tokens: CodeToken[][] | null; first: number };
}

/**
 * 伪代码和源码两个标签页看的是同一段源码，来回切换时不必重复请求。
 * 键里带上仓库修订号，重扫或换仓库后自然失效。
 */
const sliceCache = new Map<string, Promise<SourceSliceDto>>();
const SLICE_CACHE_SIZE = 16;

function loadSlice(key: string, fileId: string, from?: number, to?: number): Promise<SourceSliceDto> {
  const cached = sliceCache.get(key);
  if (cached) return cached;
  const task = api.source(fileId, from, to);
  sliceCache.set(key, task);
  task.catch(() => sliceCache.delete(key));
  if (sliceCache.size > SLICE_CACHE_SIZE) {
    const oldest = sliceCache.keys().next().value;
    if (oldest !== undefined) sliceCache.delete(oldest);
  }
  return task;
}

export function useSource(
  fileId: string,
  from?: number,
  to?: number,
): { source: LoadedSource | null; error: string | null } {
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const key = `${repoId ?? ""}:${repoRevision}:${fileId}:${from ?? ""}:${to ?? ""}`;
  const [state, setState] = useState<{ key: string; slice: SourceSliceDto | null; error: string | null }>({
    key: "",
    slice: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    void loadSlice(key, fileId, from, to)
      .then((slice) => !cancelled && setState({ key, slice, error: null }))
      .catch((err: Error) => !cancelled && setState({ key, slice: null, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [key, fileId, from, to]);

  const slice = state.key === key ? state.slice : null;
  const tokens = useHighlightedLines(slice?.code ?? null, slice ? shikiLanguage(slice.language, slice.path) : null);

  // 引用稳定才能被下游当作 effect 依赖；否则每次渲染都像是换了一份源码
  const source = useMemo<LoadedSource | null>(() => {
    if (!slice) return null;
    const lines = slice.code.split("\n");
    return {
      slice,
      lines,
      tokens,
      range: (rangeFrom, rangeTo) => {
        const first = Math.max(rangeFrom, slice.startLine);
        const last = Math.min(rangeTo, slice.startLine + lines.length - 1);
        const start = first - slice.startLine;
        const end = Math.max(start, last - slice.startLine + 1);
        return {
          first,
          lines: lines.slice(start, end),
          tokens: tokens ? tokens.slice(start, end) : null,
        };
      },
    };
  }, [slice, tokens]);

  return { source, error: slice || state.key !== key ? null : state.error };
}
