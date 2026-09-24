/// <reference lib="webworker" />
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** [文本, 颜色（CSS 变量引用，null 表示默认前景色）, fontStyle 位标记] */
export type CodeToken = [string, string | null, number];

export interface HighlightRequest {
  id: number;
  code: string;
  lang: string;
}

export interface HighlightResponse {
  id: number;
  lines?: CodeToken[][] | null;
  error?: string;
}

type GrammarModule = { default: LanguageRegistration[] };

/**
 * 只列出实际会遇到的语言，每种语法单独成块、第一次用到时才加载。
 * 全量 bundle 有两百多种语法，几 MB 的体积换来的是永远用不上的覆盖率。
 */
const GRAMMARS: Record<string, () => Promise<GrammarModule>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  astro: () => import("shiki/langs/astro.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  nim: () => import("shiki/langs/nim.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  protobuf: () => import("shiki/langs/protobuf.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
};

const THEME_NAME = "repolens";
const DEFAULT_COLOR = "var(--code-foreground)";

let highlighter: Promise<HighlighterCore> | null = null;
const loadedGrammars = new Map<string, Promise<boolean>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME_NAME, variablePrefix: "--code-", fontStyle: true })],
    langs: [],
    // forgiving：个别 Oniguruma 独有的正则无法翻译时跳过那条规则，
    // 而不是让整份文件退回纯文本。
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

function ensureGrammar(core: HighlighterCore, lang: string): Promise<boolean> {
  let pending = loadedGrammars.get(lang);
  if (!pending) {
    const load = GRAMMARS[lang];
    pending = load
      ? load().then(async (mod) => {
          await core.loadLanguage(mod.default);
          return true;
        })
      : Promise.resolve(false);
    loadedGrammars.set(lang, pending);
  }
  return pending;
}

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, code, lang } = event.data;
  const reply = (response: HighlightResponse) => self.postMessage(response);
  try {
    const core = await getHighlighter();
    if (!(await ensureGrammar(core, lang))) {
      reply({ id, lines: null });
      return;
    }
    const tokens = core.codeToTokensBase(code, { lang, theme: THEME_NAME });
    reply({
      id,
      lines: tokens.map((line) =>
        line.map((token): CodeToken => [
          token.content,
          token.color && token.color !== DEFAULT_COLOR ? token.color : null,
          token.fontStyle ?? 0,
        ]),
      ),
    });
  } catch (err) {
    reply({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
