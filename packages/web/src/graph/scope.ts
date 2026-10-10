import type { GraphDto, GraphNodeKind, OverviewDto } from "@repolens/core/types";
import { findNode } from "./model";

/** 一个节点在仓库里占的那块地方。结构树跟着选中项展开、侧栏清单按聚焦收窄都靠它 */
export interface NodeScope {
  id: string;
  kind: "package" | "directory" | "file" | "symbol";
  label: string;
  /** 仓库相对路径，符号取所在文件，仓库根是 "." */
  path: string;
}

const SCOPE_KINDS = new Set<GraphNodeKind>(["package", "directory", "file", "symbol"]);

/**
 * 不发请求能定下来的就地算出。返回 undefined 表示是文件或符号、又不在已加载的图里，
 * 要问服务端；null 表示这个节点没有落点（聚合节点、外部依赖）。
 */
export function scopeOf(
  nodeId: string,
  subgraphs: Record<string, GraphDto>,
  packages: OverviewDto["packages"],
): NodeScope | null | undefined {
  const dto = findNode(subgraphs, nodeId);
  if (dto && dto.path != null && SCOPE_KINDS.has(dto.kind)) {
    return { id: nodeId, kind: dto.kind as NodeScope["kind"], label: dto.label, path: dto.path };
  }
  const colon = nodeId.indexOf(":");
  const prefix = nodeId.slice(0, colon);
  const rest = nodeId.slice(colon + 1);
  if (prefix === "dir") return { id: nodeId, kind: "directory", label: baseName(rest), path: rest };
  if (prefix === "raw") return { id: nodeId, kind: "file", label: baseName(rest), path: rest };
  if (prefix === "pkg") {
    const pkg = packages.find((p) => p.id === nodeId);
    return pkg ? { id: nodeId, kind: "package", label: pkg.name, path: pkg.dir } : null;
  }
  return prefix === "file" || prefix === "sym" ? undefined : null;
}

/** 落在范围里的条目。带 symbolId 的条目在符号范围里按 id 比，其余一律按路径 */
export function inScope(scope: NodeScope, path: string, symbolId?: string | null): boolean {
  if (scope.kind === "symbol") return symbolId !== undefined ? symbolId === scope.id : path === scope.path;
  if (scope.kind === "file") return path === scope.path;
  return scope.path === "." || path === scope.path || path.startsWith(`${scope.path}/`);
}

export function baseName(path: string): string {
  return path.split("/").at(-1) || path;
}
