/**
 * What is on disk beside the Xcode project.
 *
 * Two config fields used to restate a directory listing: which `.xcodeproj` to
 * build, and whether an XcodeGen spec exists. Both are read from the directory
 * instead. `project.xcodeproj` survives as an override for the one case a
 * listing cannot settle — several projects in one directory — and
 * `project.xcodegen` survives because regenerating before a build is a real
 * choice, not a fact about the directory.
 */
import type { Boundary } from './boundary.js';
import { fail } from './errors.js';

const XCODE_PROJECT_SUFFIX = '.xcodeproj';

/** Names of the XcodeGen spec, in the order XcodeGen itself looks for them. */
const SPEC_NAMES = ['project.yml', 'project.yaml'] as const;

const listing = (boundary: Boundary, directory: string): string[] =>
  boundary.fs.isDirectory(directory) ? boundary.fs.readdir(directory) : [];

/** Every `.xcodeproj` in this directory, sorted so a listing reads the same twice. */
export function xcodeprojNames(boundary: Boundary, directory: string): string[] {
  return listing(boundary, directory)
    .filter((name) => name.endsWith(XCODE_PROJECT_SUFFIX))
    .sort();
}

/** The XcodeGen spec beside the project, or nothing. */
export function projectSpecName(boundary: Boundary, directory: string): string | undefined {
  const names = listing(boundary, directory);
  return SPEC_NAMES.find((candidate) => names.includes(candidate));
}

/**
 * What to say when the `.xcodeproj` is absent and a spec is there.
 *
 * The project is generated output, so the fix is to generate it — never to
 * correct a path, which is what every other "cannot find the project" message
 * in this tool means. One spelling, because a person who hits this from the
 * build, the bundle ids, or a bare `bundles ls` is in the same situation.
 */
export const ungeneratedAdvice = (directory: string): string =>
  `Run \`xcodegen generate\` in ${directory}, or set project.xcodegen so jetbridge runs it ` +
  'for you.';

/**
 * Which `.xcodeproj` to build.
 *
 * Inferred when the directory holds exactly one, which is the ordinary project.
 * Several is the only case a person has to settle, and the error lists what was
 * found so the answer can be copied out of it. None yields nothing rather than
 * failing when a workspace or an XcodeGen spec explains the absence.
 */
export function resolveXcodeproj(
  boundary: Boundary,
  directory: string,
  config: { xcodeproj?: string; xcworkspace?: string },
): string | undefined {
  if (config.xcodeproj) return config.xcodeproj;
  const found = xcodeprojNames(boundary, directory);
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    // A generated project is absent until XcodeGen has run, and every command
    // that needs it says so at the point it needs it. Failing here would break
    // `bundles ls` on a fresh clone, where nothing has to be built at all.
    if (config.xcworkspace || projectSpecName(boundary, directory)) return undefined;
    fail(
      `no .xcodeproj was found in ${directory}.\n` +
        '  Set project.iosDir to the directory that holds it, or project.xcworkspace if the ' +
        'build opens a workspace.',
    );
  }
  fail(
    `${directory} holds more than one .xcodeproj, so set project.xcodeproj to the one to ` +
      `build:\n${found.map((name) => `  ${name}`).join('\n')}`,
  );
}
