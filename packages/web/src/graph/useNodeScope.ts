import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api/client";
import { useAppStore } from "../store/useAppStore";
import { type NodeScope, baseName, scopeOf } from "./scope";

const fetched = new Map<string, Promise<NodeScope | null>>();

function fetchScope(nodeId: string, revision: number): Promise<NodeScope | null> {
  const key = `${revision}:${nodeId}`;
  let pending = fetched.get(key);
  if (!pending) {
    pending = nodeId.startsWith("sym:")
      ? api.symbol(nodeId).then((s) => ({
        id: nodeId, kind: "symbol" as const, label: s.container ? `${s.container}.${s.name}` : s.name, path: s.filePath,
      }))
      : api.file(nodeId).then((f) => ({ id: nodeId, kind: "file" as const, label: baseName(f.path), path: f.path }));
    pending = pending.catch(() => null);
    fetched.set(key, pending);
  }
  return pending;
}

/** 节点不在已加载的图里时（比如结构树里点的灰色文件）去服务端问它在哪 */
export function useNodeScope(nodeId: string | null): NodeScope | null {
  const repoRevision = useAppStore((s) => s.repoRevision);
  const local = useAppStore(useShallow((s) =>
    nodeId === null ? null : scopeOf(nodeId, s.subgraphs, s.overview?.packages ?? [])));
  const [remote, setRemote] = useState<NodeScope | null>(null);

  useEffect(() => {
    if (nodeId === null || local !== undefined) return;
    let stale = false;
    void fetchScope(nodeId, repoRevision).then((scope) => { if (!stale) setRemote(scope); });
    return () => { stale = true; };
  }, [nodeId, local, repoRevision]);

  if (local !== undefined) return local;
  return remote?.id === nodeId ? remote : null;
}
