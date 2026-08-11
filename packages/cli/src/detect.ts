/**
 * Reading an Xcode project so the wizard has to ask as little as possible.
 *
 * Every answer here is a SUGGESTION carrying the file it came from. A guess
 * that never surfaces costs a whole build to discover it was wrong, so nothing
 * detected is ever accepted silently — the wizard shows it, sourced, as the
 * default.
 *
 * `project.pbxproj` is an OpenStep property list. It is parsed as one instead
 * of grepped, because the interesting values only mean anything in context: a
 * `PRODUCT_BUNDLE_IDENTIFIER` belongs to a build configuration, which belongs
 * to a target, and a project with `Debug`, `Release` and `Staging` has three of
 * them saying different things. Anything unparseable degrades to a partial
 * result with a warning — a strange project must still reach the questions.
 */
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Boundary } from './boundary.js';
import { projectSpecName, xcodeprojNames } from './project-layout.js';

/** A detected value and the file that produced it. */
export interface Suggestion<T> {
  value: T;
  /** Path relative to the project root, for a message a human can check. */
  source: string;
}

export interface DetectedTarget {
  name: string;
  productType?: string;
  isApp: boolean;
  bundleId?: string;
  /** One bundle-id segment for an extension; unset for the app itself. */
  bundleIdSuffix?: string;
  entitlements?: Suggestion<string>;
  /** A reduced entitlements file found beside the shipping one. */
  variantEntitlements?: Suggestion<string>;
}

export interface Detection {
  root: string;
  iosDir: Suggestion<string>;
  xcodeproj?: Suggestion<string>;
  xcworkspace?: Suggestion<string>;
  projectYml?: Suggestion<string>;
  configurations?: Suggestion<string[]>;
  schemes: string[];
  scheme?: Suggestion<string>;
  teamId?: Suggestion<string>;
  baseBundleId?: Suggestion<string>;
  displayName?: Suggestion<string>;
  targets: DetectedTarget[];
  /** Everything the wizard should say out loud before it starts asking. */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* The OpenStep plist subset a pbxproj is written in                          */
/* -------------------------------------------------------------------------- */

type PlistValue = string | PlistValue[] | { [key: string]: PlistValue };

const isDict = (value: PlistValue | undefined): value is { [key: string]: PlistValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: PlistValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * A hand-written parser rather than a dependency: the grammar is four
 * productions, and every pbxproj library on npm is either abandoned or an order
 * of magnitude more code than this.
 */
export function parsePlist(text: string): PlistValue {
  let at = 0;

  const skip = (): void => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at]!)) at += 1;
      if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at);
        at = end === -1 ? text.length : end + 1;
        continue;
      }
      if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2);
        at = end === -1 ? text.length : end + 2;
        continue;
      }
      return;
    }
  };

  const quoted = (): string => {
    at += 1;
    let out = '';
    while (at < text.length && text[at] !== '"') {
      if (text[at] === '\\') {
        out += text[at + 1] ?? '';
        at += 2;
        continue;
      }
      out += text[at];
      at += 1;
    }
    at += 1;
    return out;
  };

  const bare = (): string => {
    const start = at;
    while (at < text.length && !/[\s;,=(){}]/.test(text[at]!)) at += 1;
    if (at === start) throw new Error(`unexpected "${text[at]}" at ${at}`);
    return text.slice(start, at);
  };

  const value = (): PlistValue => {
    skip();
    const char = text[at];
    if (char === '{') return dict();
    if (char === '(') return array();
    if (char === '"') return quoted();
    return bare();
  };

  const dict = (): { [key: string]: PlistValue } => {
    at += 1;
    const out: { [key: string]: PlistValue } = {};
    for (;;) {
      skip();
      if (text[at] === '}') {
        at += 1;
        return out;
      }
      if (at >= text.length) throw new Error('unterminated {');
      const key = text[at] === '"' ? quoted() : bare();
      skip();
      if (text[at] !== '=') throw new Error(`expected = after ${key}`);
      at += 1;
      out[key] = value();
      skip();
      if (text[at] === ';') at += 1;
    }
  };

  const array = (): PlistValue[] => {
    at += 1;
    const out: PlistValue[] = [];
    for (;;) {
      skip();
      if (text[at] === ')') {
        at += 1;
        return out;
      }
      if (at >= text.length) throw new Error('unterminated (');
      out.push(value());
      skip();
      if (text[at] === ',') at += 1;
    }
  };

  skip();
  // A pbxproj starts with a bare `// !$*UTF8*$!` line, already skipped above.
  return value();
}

export interface PbxTarget {
  name: string;
  productType?: string;
  /** Build settings for this target, by build-configuration name. */
  settings: Record<string, Record<string, string>>;
}

export interface PbxprojFacts {
  /** The project's own build configuration list — what `-configuration` accepts. */
  projectConfigurations: string[];
  /** Every configuration name in the file, target-local ones included. */
  allConfigurations: string[];
  /** Project-level build settings, by configuration name. */
  projectSettings: Record<string, Record<string, string>>;
  targets: PbxTarget[];
  warnings: string[];
}

const emptyFacts = (warnings: string[]): PbxprojFacts => ({
  projectConfigurations: [],
  allConfigurations: [],
  projectSettings: {},
  targets: [],
  warnings,
});

/** Flatten a `buildSettings` dict, dropping the list-valued settings nobody here reads. */
function scalarSettings(value: PlistValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isDict(value)) return out;
  for (const [key, setting] of Object.entries(value)) {
    if (typeof setting === 'string') out[key] = setting;
  }
  return out;
}

export function parsePbxproj(text: string): PbxprojFacts {
  let root: PlistValue;
  try {
    root = parsePlist(text);
  } catch (e) {
    return emptyFacts([`project.pbxproj could not be parsed — ${(e as Error).message}`]);
  }
  if (!isDict(root) || !isDict(root.objects)) {
    return emptyFacts(['project.pbxproj has no objects section']);
  }

  const warnings: string[] = [];
  const objects = root.objects;
  const object = (id: PlistValue | undefined): { [key: string]: PlistValue } | undefined => {
    const found = typeof id === 'string' ? objects[id] : undefined;
    return isDict(found) ? found : undefined;
  };

  /** Configuration name → build settings, for one `XCConfigurationList` id. */
  const settingsFor = (listId: PlistValue | undefined): Record<string, Record<string, string>> => {
    const out: Record<string, Record<string, string>> = {};
    const list = object(listId);
    const ids = list?.buildConfigurations;
    if (!Array.isArray(ids)) return out;
    for (const id of ids) {
      const configuration = object(id);
      const name = asString(configuration?.name);
      if (!name) continue;
      out[name] = scalarSettings(configuration?.buildSettings);
    }
    return out;
  };

  const allConfigurations = new Set<string>();
  for (const entry of Object.values(objects)) {
    if (isDict(entry) && entry.isa === 'XCBuildConfiguration') {
      const name = asString(entry.name);
      if (name) allConfigurations.add(name);
    }
  }

  const project =
    object(root.rootObject) ??
    Object.values(objects).find((entry) => isDict(entry) && entry.isa === 'PBXProject');
  const projectSettings = settingsFor(isDict(project) ? project.buildConfigurationList : undefined);
  let projectConfigurations = Object.keys(projectSettings);
  if (projectConfigurations.length === 0) {
    // Falling back to every configuration in the file can sweep in a
    // target-local one that `-configuration` will not accept, so say so.
    projectConfigurations = [...allConfigurations];
    if (projectConfigurations.length > 0) {
      warnings.push(
        'the project-level build configuration list could not be read, so the configuration ' +
          'names come from every target in the file — check them.',
      );
    }
  }

  const targets: PbxTarget[] = [];
  const targetIds = isDict(project) && Array.isArray(project.targets) ? project.targets : [];
  const entries = targetIds.length
    ? targetIds.map((id) => object(id))
    : Object.values(objects).map((entry) => (isDict(entry) ? entry : undefined));
  for (const entry of entries) {
    if (!entry || entry.isa !== 'PBXNativeTarget') continue;
    const name = asString(entry.name);
    if (!name) continue;
    const productType = asString(entry.productType);
    targets.push({
      name,
      ...(productType ? { productType } : {}),
      settings: settingsFor(entry.buildConfigurationList),
    });
  }
  if (targets.length === 0) warnings.push('no native targets were found in project.pbxproj');

  return {
    projectConfigurations,
    allConfigurations: [...allConfigurations],
    projectSettings,
    targets,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* From facts to suggestions                                                  */
/* -------------------------------------------------------------------------- */

const APP_PRODUCT_TYPE = 'com.apple.product-type.application';

const isExtension = (productType: string | undefined): boolean =>
  Boolean(productType && /app-extension|watchkit2-app|extensionkit-extension/.test(productType));

/**
 * One setting's value, preferring the configuration a build will actually name.
 * Reports a disagreement instead of picking a winner: `Debug` and `Release`
 * carrying different bundle ids is normal, and the difference is the thing
 * worth showing.
 */
/**
 * Resolve `$(OTHER_SETTING)` references against the same configuration.
 *
 * A project that supports variant builds necessarily templates its bundle id —
 * `io.acme.app.dev$(JETBRIDGE_SUFFIX)` — and defines the referenced setting
 * right beside it, usually empty. Refusing to read that and asking the person
 * to retype their own bundle id is the tool failing at the one thing it is
 * looking at.
 *
 * Bounded, because a setting can reference itself. An unresolved reference is
 * left in place, and the caller decides what that means.
 */
export function expandSettingRefs(
  value: string,
  values: Record<string, string>,
  depth = 0,
): string {
  if (depth > 4 || !value.includes('$(')) return value;
  const expanded = value.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (whole, name: string) =>
    name in values ? values[name]! : whole,
  );
  return expanded === value ? value : expandSettingRefs(expanded, values, depth + 1);
}

export function settingValue(
  settings: Record<string, Record<string, string>>,
  key: string,
  preferred: string[],
): { value: string; configuration: string; differs: boolean } | undefined {
  const found = Object.entries(settings)
    .map(([configuration, values]) => ({
      configuration,
      value: values[key] === undefined ? undefined : expandSettingRefs(values[key], values),
    }))
    .filter((entry): entry is { configuration: string; value: string } => Boolean(entry.value));
  if (found.length === 0) return undefined;
  const chosen = preferred.map((name) => found.find((e) => e.configuration === name)).find(Boolean);
  const winner = chosen ?? found[0]!;
  return {
    value: winner.value,
    configuration: winner.configuration,
    differs: new Set(found.map((e) => e.value)).size > 1,
  };
}

/** A path inside the project root, or nothing — the schema refuses the rest. */
function insideRoot(root: string, base: string, value: string): string | undefined {
  if (value.includes('$(') || value.includes('${')) return undefined;
  const absolute = isAbsolute(value) ? value : resolve(base, value);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel;
}

/** `Upload Widget` → `uploadwidget`: one bundle-id segment, or nothing. */
export function bundleIdSuffixFrom(value: string): string | undefined {
  const squeezed = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return squeezed.length > 0 ? squeezed : undefined;
}

/**
 * Where a target's reduced entitlements file would be, given the shipping one.
 *
 * The one thing about a variant build that no Xcode project can state — it
 * describes what ships, and a variant deliberately signs against less. Two
 * spellings occur in real projects: the file beside the shipping one
 * (`Acme/Acme-variant.entitlements`), and the same name in a `config/`
 * directory next to it. Both are offered, and the caller keeps whichever exist.
 */
export function variantEntitlementsCandidates(shipping: string): string[] {
  const base = basename(shipping);
  const dot = base.lastIndexOf('.');
  const name = dot === -1 ? `${base}-variant` : `${base.slice(0, dot)}-variant${base.slice(dot)}`;
  const directory = dirname(shipping);
  return [join(directory, name), join(directory, 'config', name)];
}

export interface DetectOptions {
  /** Where the config file will live. Every suggested path is relative to it. */
  root: string;
  /** Skip the search and read this directory, relative to `root`. */
  iosDir?: string;
}

const XCODE_PROJECT_SUFFIX = '.xcodeproj';
const XCODE_WORKSPACE_SUFFIX = '.xcworkspace';

/** The directory holding an `.xcodeproj` or `.xcworkspace`: the root, or one below it. */
export function findProjectDirectory(boundary: Boundary, root: string): string | undefined {
  const holdsProject = (dir: string): boolean => {
    if (!boundary.fs.isDirectory(dir)) return false;
    return boundary.fs
      .readdir(dir)
      .some((name) => name.endsWith(XCODE_PROJECT_SUFFIX) || name.endsWith(XCODE_WORKSPACE_SUFFIX));
  };
  if (holdsProject(root)) return root;
  if (!boundary.fs.isDirectory(root)) return undefined;
  for (const name of boundary.fs.readdir(root)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const candidate = join(root, name);
    if (holdsProject(candidate)) return candidate;
  }
  return undefined;
}

function schemeNames(boundary: Boundary, container: string): string[] {
  const directory = join(container, 'xcshareddata', 'xcschemes');
  if (!boundary.fs.isDirectory(directory)) return [];
  return boundary.fs
    .readdir(directory)
    .filter((name) => name.endsWith('.xcscheme'))
    .map((name) => name.slice(0, -'.xcscheme'.length));
}

export function detectProject(boundary: Boundary, options: DetectOptions): Detection {
  const root = resolve(options.root);
  const warnings: string[] = [];
  const explicit = options.iosDir ? resolve(root, options.iosDir) : undefined;
  const directory = explicit ?? findProjectDirectory(boundary, root);

  if (!directory) {
    return {
      root,
      iosDir: { value: options.iosDir ?? '.', source: '.' },
      schemes: [],
      targets: [],
      warnings: ['no .xcodeproj or .xcworkspace was found here or one directory below.'],
    };
  }

  const iosDir = relative(root, directory) || '.';
  const names = boundary.fs.isDirectory(directory) ? boundary.fs.readdir(directory) : [];
  const projectName = xcodeprojNames(boundary, directory)[0];
  const workspaceName = names.find((name) => name.endsWith(XCODE_WORKSPACE_SUFFIX));
  const specName = projectSpecName(boundary, directory);

  const detection: Detection = {
    root,
    iosDir: { value: iosDir, source: iosDir },
    ...(projectName ? { xcodeproj: { value: projectName, source: iosDir } } : {}),
    ...(workspaceName ? { xcworkspace: { value: workspaceName, source: iosDir } } : {}),
    ...(specName ? { projectYml: { value: specName, source: join(iosDir, specName) } } : {}),
    schemes: [],
    targets: [],
    warnings,
  };

  if (!projectName) {
    warnings.push(
      workspaceName
        ? `${workspaceName} has no .xcodeproj beside it, so nothing could be read out of the project.`
        : 'no .xcodeproj was found, so nothing could be read out of the project.',
    );
    return detection;
  }

  const projectDir = join(directory, projectName);
  const pbxprojPath = join(projectDir, 'project.pbxproj');
  const sourceOf = (path: string): string => relative(root, path);

  detection.schemes = [
    ...new Set([
      ...schemeNames(boundary, projectDir),
      ...(workspaceName ? schemeNames(boundary, join(directory, workspaceName)) : []),
    ]),
  ];

  if (!boundary.fs.exists(pbxprojPath)) {
    warnings.push(`${sourceOf(pbxprojPath)} is missing, so nothing could be read out of it.`);
    return detection;
  }

  let facts: PbxprojFacts;
  try {
    facts = parsePbxproj(boundary.fs.read(pbxprojPath));
  } catch (e) {
    warnings.push(`${sourceOf(pbxprojPath)} could not be read — ${(e as Error).message}`);
    return detection;
  }
  const pbxSource = sourceOf(pbxprojPath);
  warnings.push(...facts.warnings.map((warning) => `${pbxSource}: ${warning}`));

  if (facts.projectConfigurations.length > 0) {
    detection.configurations = { value: facts.projectConfigurations, source: pbxSource };
  }

  // `Debug` first: it is what the cabled inner loop builds, so its values are
  // the ones a wrong guess is felt in first.
  const preferred = [
    'Debug',
    ...facts.projectConfigurations.filter((name) => name !== 'Debug'),
  ] as string[];

  const app = facts.targets.find((target) => target.productType === APP_PRODUCT_TYPE);
  if (!app && facts.targets.length > 0) {
    warnings.push(`${pbxSource}: no application target was found — pick one by hand.`);
  }

  const readSetting = (
    target: PbxTarget | undefined,
    key: string,
  ): { value: string; configuration: string; differs: boolean } | undefined =>
    (target ? settingValue(target.settings, key, preferred) : undefined) ??
    settingValue(facts.projectSettings, key, preferred);

  const teamId = readSetting(app, 'DEVELOPMENT_TEAM');
  if (teamId) {
    if (/^[A-Z0-9]{10}$/.test(teamId.value)) {
      detection.teamId = { value: teamId.value, source: pbxSource };
    } else {
      warnings.push(
        `${pbxSource}: DEVELOPMENT_TEAM is "${teamId.value}", which is not a 10-character team id.`,
      );
    }
  }

  const bundleId = app
    ? settingValue(app.settings, 'PRODUCT_BUNDLE_IDENTIFIER', preferred)
    : undefined;
  if (bundleId?.value.includes('$(')) {
    warnings.push(
      `${pbxSource}: PRODUCT_BUNDLE_IDENTIFIER is built from other build settings ` +
        `("${bundleId.value}"), so it has to be given by hand.`,
    );
  } else if (bundleId) {
    detection.baseBundleId = { value: bundleId.value, source: pbxSource };
    if (bundleId.differs) {
      warnings.push(
        `${pbxSource}: the bundle id differs between configurations — ${bundleId.configuration} ` +
          `says "${bundleId.value}".`,
      );
    }
  }

  const displayName = app
    ? settingValue(app.settings, 'INFOPLIST_KEY_CFBundleDisplayName', preferred)
    : undefined;
  if (displayName && !displayName.value.includes('$(')) {
    detection.displayName = { value: displayName.value, source: pbxSource };
  } else if (app) {
    detection.displayName = { value: app.name, source: pbxSource };
  }

  if (app) {
    const matching = detection.schemes.find((scheme) => scheme === app.name);
    detection.scheme = matching
      ? { value: matching, source: sourceOf(join(projectDir, 'xcshareddata', 'xcschemes')) }
      : { value: app.name, source: pbxSource };
  } else if (detection.schemes.length === 1) {
    detection.scheme = {
      value: detection.schemes[0]!,
      source: sourceOf(join(projectDir, 'xcshareddata', 'xcschemes')),
    };
  }

  for (const target of facts.targets) {
    const isApp = target.productType === APP_PRODUCT_TYPE;
    if (!isApp && !isExtension(target.productType)) continue;

    const id = settingValue(target.settings, 'PRODUCT_BUNDLE_IDENTIFIER', preferred)?.value;
    const entitlements = settingValue(target.settings, 'CODE_SIGN_ENTITLEMENTS', preferred)?.value;
    const relativeEntitlements = entitlements
      ? insideRoot(root, directory, entitlements)
      : undefined;
    if (entitlements && !relativeEntitlements) {
      warnings.push(
        `${pbxSource}: ${target.name}'s entitlements path ("${entitlements}") is outside the ` +
          'project root, so it was left out.',
      );
    }

    // Only ONE candidate is a default. Two files that both look like the
    // variant entitlements is a question, not a guess: picking one silently
    // signs the variant against entitlements nobody chose.
    const variants = relativeEntitlements
      ? variantEntitlementsCandidates(relativeEntitlements).filter((candidate) =>
          boundary.fs.exists(resolve(root, candidate)),
        )
      : [];
    if (variants.length > 1) {
      warnings.push(
        `${target.name} has more than one file that could be its variant entitlements ` +
          `(${variants.join(', ')}) — pick one by hand.`,
      );
    }

    // An extension without a usable id segment would read as a second app
    // target, which the schema refuses. Leave it out and say so.
    const suffix = isApp
      ? undefined
      : bundleIdSuffixFrom(id?.split('.').pop() ?? target.name.split('.').pop() ?? '');
    if (!isApp && !suffix) {
      warnings.push(
        `${pbxSource}: ${target.name} has no usable bundle-id segment — add it by hand.`,
      );
      continue;
    }

    detection.targets.push({
      name: target.name,
      ...(target.productType ? { productType: target.productType } : {}),
      isApp,
      ...(id && !id.includes('$(') ? { bundleId: id } : {}),
      ...(suffix ? { bundleIdSuffix: suffix } : {}),
      ...(relativeEntitlements
        ? { entitlements: { value: relativeEntitlements, source: pbxSource } }
        : {}),
      ...(variants.length === 1
        ? { variantEntitlements: { value: variants[0]!, source: variants[0]! } }
        : {}),
    });
  }

  return detection;
}
