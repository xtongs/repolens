export * from "./types.js";
export { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from "./config.js";

export {
  getMeta,
  getMetaJson,
  indexPath,
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

// RegisteredRepo / RepoEntry / RepoStatus 这几个类型由 types.js 的 `export *`
// 带出，这里不重复导出，否则同一个名字有两条来路。
export {
  HOME_DIR,
  REGISTRY_FILE,
  forgetRepo,
  listRepos,
  probe,
  readRegistry,
  registryPath,
  rememberRepo,
  repoId,
} from "./registry.js";

export { scanRepo, type ScanOptions, type ScanPhase } from "./pipeline/scan.js";
export { countLoc } from "./pipeline/metrics.js";

export { detectLanguage, isAnalyzable } from "./discovery/language.js";
export { classifyRole } from "./discovery/roles.js";
export { discoverPackages } from "./discovery/workspace.js";
export { walkRepo } from "./discovery/walk.js";

export { ParserPool } from "./parse/parser-pool.js";
export { extractorFor } from "./parse/extractors/registry.js";
export { createResolvers } from "./resolve/registry.js";
export * from "./resolve/path-utils.js";
