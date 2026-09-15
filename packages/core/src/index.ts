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
