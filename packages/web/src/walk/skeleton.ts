import type { ControlBlock, ControlBlockKind, WalkCallDto, WalkFrameDto } from "@repolens/core/types";

export interface StepOptions {
  /** 外部库和解析不了的调用也当步骤 */
  all: boolean;
  /** 计时、日志、埋点这类旁路调用也当步骤 */
  trivial: boolean;
  /** 只看主路径：守卫分支（提前 return/throw 的 if）和 catch 里的调用不算 */
  mainPath: boolean;
}

export interface Skeleton {
  steps: WalkCallDto[];
  /** 同一块里重复调用同一个函数，只留第一次当步骤；这里记着被合并掉的后几次 */
  repeats: Map<string, WalkCallDto[]>;
  /** 被折叠的旁路调用、主路径之外的调用各有几处 */
  folded: { trivial: number; offPath: number };
}

/** 默认只把能落到仓库内函数的调用和 I/O 当步骤，和服务端算「还能走几步」的口径一致 */
export function walkable(call: WalkCallDto): boolean {
  return call.resolution === "exact" || call.resolution === "likely" || call.resolution === "ambiguous" || !!call.io;
}

/** 守卫分支或错误处理里的调用：读主线时可以先跳过 */
export function offMainPath(call: WalkCallDto): boolean {
  return (call.blocks ?? []).some((block) => (block.k === "if" && block.x === 1) || block.k === "catch");
}

/**
 * 把函数体里的调用整理成走读的步骤。顺序不变，只做减法：先按「全部调用」筛，再折叠旁路调用、
 * 去掉主路径之外的，最后把同一块里对同一个仓库内函数的重复调用合成一步。减掉了多少都照实记下。
 */
export function buildSkeleton(frame: WalkFrameDto, options: StepOptions): Skeleton {
  const folded = { trivial: 0, offPath: 0 };
  const candidates = frame.calls.filter((call) => {
    if (!options.all && !walkable(call)) return false;
    if (!options.trivial && call.trivial && !call.io) {
      folded.trivial++;
      return false;
    }
    if (options.mainPath && offMainPath(call)) {
      folded.offPath++;
      return false;
    }
    return true;
  });

  const steps: WalkCallDto[] = [];
  const repeats = new Map<string, WalkCallDto[]>();
  const firstOf = new Map<string, WalkCallDto>();
  for (const call of candidates) {
    const target = call.resolution === "ambiguous" ? null : call.target;
    if (!target) {
      steps.push(call);
      continue;
    }
    const key = `${blockKey(call)}|${target.id}`;
    const first = firstOf.get(key);
    if (!first) {
      firstOf.set(key, call);
      steps.push(call);
      continue;
    }
    const list = repeats.get(first.id);
    if (list) list.push(call); else repeats.set(first.id, [call]);
  }
  return { steps, repeats, folded };
}

/** 显示用的控制块：else 紧跟着同一行的 if 合成一个 else if */
export interface DisplayBlock {
  /** 用最内层那块的起始字节当 key */
  key: string;
  kind: ControlBlockKind | "else-if";
  text: string | undefined;
  line: number;
  guard: boolean;
}

export function displayBlocks(call: WalkCallDto): DisplayBlock[] {
  const blocks = call.blocks ?? [];
  const out: DisplayBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    if (block.k === "else" && next?.k === "if" && next.l === block.l) {
      out.push({ key: `${block.b}:${next.b}`, kind: "else-if", text: next.t, line: next.l, guard: next.x === 1 });
      i++;
      continue;
    }
    out.push({ key: String(block.b), kind: block.k, text: block.t, line: block.l, guard: block.x === 1 });
  }
  return out;
}

/** 渲染步骤清单时插进去的块标题：和上一步相比新进入的那几层 */
export function openedBlocks(previous: WalkCallDto | null, call: WalkCallDto): Array<{ block: DisplayBlock; depth: number }> {
  const before = previous ? displayBlocks(previous) : [];
  const now = displayBlocks(call);
  let shared = 0;
  while (shared < before.length && shared < now.length && before[shared]!.key === now[shared]!.key) shared++;
  return now.slice(shared).map((block, index) => ({ block, depth: shared + index }));
}

function blockKey(call: WalkCallDto): string {
  return (call.blocks ?? []).map((block: ControlBlock) => block.b).join(".");
}
