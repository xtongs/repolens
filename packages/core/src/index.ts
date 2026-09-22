export * from "./types.js";
export {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_FILENAME,
  globalConfigPath,
  loadConfig,
} from "./config.js";

export {
  getMeta,
  getMetaJson,
  indexPath,
  isIndexCurrent,
  INDEX_DIR,
  INDEX_FILE,
  openDb,
  setMeta,
  setMetaJson,
  transact,
  type Db,
} from "./db/database.js";

export {
  EXTERNAL_NODE_ID,
  ROOT_SCOPE,
  getCallGraph,
  getFindings,
  getFindingSummary,
  getRevealChain,
  getFileDetail,
  getOverview,
  getScopeGraph,
  getSource,
  getSymbolDetail,
  getTree,
  search,
  symbolKey,
  type GraphOptions,
} from "./db/queries.js";

export { getEntryPoints, getTrace, getTraceSummaries } from "./db/traces.js";

// RegisteredRepo / RepoEntry / RepoStatus 这几个类型由 types.js 的 `export *`
// 带出，这里不重复导出，否则同一个名字有两条来路。
export {
  HOME_DIR,
  REGISTRY_FILE,
  forgetRepo,
  gitBranch,
  listRepos,
  probe,
  readRegistry,
  registryPath,
  rememberRepo,
  repoId,
} from "./registry.js";

export { scanRepo, type ScanOptions } from "./pipeline/scan.js";
export {
  enrichRepository,
  generateFileSummary,
  generateSymbolSemantics,
  generateTraceNarrative,
} from "./llm/enrich.js";
export { LlmResponseError, LlmUnavailableError, OpenAiCompatibleClient } from "./llm/client.js";
export { countLoc } from "./pipeline/metrics.js";

export { detectLanguage, isAnalyzable } from "./discovery/language.js";
export { classifyRole, createRoleClassifier, type RoleClassifier } from "./discovery/roles.js";
export { discoverPackages } from "./discovery/workspace.js";
export { walkRepo } from "./discovery/walk.js";

export { ParserPool } from "./parse/parser-pool.js";
export { extractorFor } from "./parse/extractors/registry.js";
export { createResolvers } from "./resolve/registry.js";
export * from "./resolve/path-utils.js";
