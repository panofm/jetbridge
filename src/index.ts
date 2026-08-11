/**
 * The programmatic surface. Everything the CLI does is callable directly, with
 * the boundary injected — which is also why the whole tool is testable without
 * Xcode, a phone, an Apple team or a bucket.
 */
export { isInteractive, nodeBoundary, nodeFileSystem } from './boundary.js';
export type {
  Boundary,
  CommandCall,
  CommandResult,
  FileSystem,
  HttpRequest,
  HttpResponse,
  Logger,
  RunOptions,
} from './boundary.js';

export {
  CONFIG_FILENAMES,
  CONFIG_VERSION,
  configSchema,
  formatConfigErrors,
  jsonSchema,
  labelPrefixFor,
  noiseWordsFor,
  parseConfig,
} from './config.js';
export type { Config, ConfigError, OtaConfig, ParseResult, TargetConfig } from './config.js';

export { JetbridgeError, fail, findConfigFile, loadProject, projectFrom } from './project.js';
export type { LoadOptions, Project } from './project.js';

export {
  ascEntityName,
  assertSingleSegment,
  bundleIdFor,
  displayNameFor,
  exceedsLabelBudget,
  sanitizeName,
  sanitizeSuffix,
  variantTitle,
  variantWords,
} from './variant.js';

export { branchSuffix, currentBranch, gitStamp, onDefaultBranch } from './git.js';
export type { GitStamp } from './git.js';

export { provisionVariant } from './provision.js';
export type { ProvisionedProfile, ProvisionOptions } from './provision.js';

export { wiredInstall } from './wired.js';
export type { WiredOptions } from './wired.js';

export { simInstall } from './sim.js';
export type { SimOptions } from './sim.js';

export { otaInstall, reindex } from './ota.js';
export type { OtaOptions, OtaResult } from './ota.js';

export { cleanVariants } from './clean.js';
export type { CleanOptions } from './clean.js';

export { runInit } from './init.js';
export type { InitOptions, InitResult } from './init.js';

export { detectProject } from './detect.js';
export type { Detection } from './detect.js';
