/**
 * A reader for the subset of plist XML Xcode writes.
 *
 * Two callers need it — the archive metadata an OTA page prints, and the
 * entitlements a target declares — so it lives on its own rather than inside
 * either of them.
 */
import type { Boundary } from './boundary.js';
import { fail } from './project.js';

export type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

const decodeEntities = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/**
 * A reader for the subset of plist XML Xcode writes.
 *
 * Shelling out to PlistBuddy for each of a dozen keys is a dozen processes, and
 * — the reason that matters here — it makes the metadata step untestable
 * without an archive on disk. Xcode's own output is `<key>`/`<string>` XML, so
 * a scanner over the tags reads it exactly.
 */
export function parsePlist(xml: string): Record<string, PlistValue> {
  const tag = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g;
  const start = xml.indexOf('<plist');
  if (start === -1) fail('that file is not a plist — it has no <plist> element');
  tag.lastIndex = start;

  interface Token {
    closing: boolean;
    name: string;
    selfClosing: boolean;
    /** Where the tag starts, so the text before it can be sliced out. */
    start: number;
    end: number;
  }

  const next = (): Token => {
    const match = tag.exec(xml);
    if (!match) fail('the plist ended in the middle of a value — it is truncated or malformed');
    return {
      closing: match[1] === '/',
      name: match[2]!,
      selfClosing: match[3] === '/',
      start: match.index,
      end: tag.lastIndex,
    };
  };

  /** Everything from here to the next tag — which is this element's close. */
  const textUntilClose = (from: number): string => decodeEntities(xml.slice(from, next().start));

  const parseValue = (name: string, selfClosing: boolean, from: number): PlistValue => {
    if (name === 'true' || name === 'false') {
      if (!selfClosing) next();
      return name === 'true';
    }
    // An empty container is written self-closing — `<dict/>`, `<array/>` — and
    // Xcode does write them. Treating one as an open tag consumes the rest of
    // the document looking for a close that never comes, and the failure
    // surfaces far away as "unexpected <plist> where a plist key was expected".
    if (selfClosing && (name === 'dict' || name === 'array')) return name === 'dict' ? {} : [];
    if (name === 'dict') {
      const dict: Record<string, PlistValue> = {};
      for (;;) {
        const token = next();
        if (token.closing && token.name === 'dict') return dict;
        if (token.name !== 'key') fail(`unexpected <${token.name}> where a plist key was expected`);
        const key = textUntilClose(token.end);
        const valueToken = next();
        dict[key] = parseValue(valueToken.name, valueToken.selfClosing, valueToken.end);
      }
    }
    if (name === 'array') {
      const array: PlistValue[] = [];
      for (;;) {
        const token = next();
        if (token.closing && token.name === 'array') return array;
        array.push(parseValue(token.name, token.selfClosing, token.end));
      }
    }
    return selfClosing ? '' : textUntilClose(from);
  };

  next(); // the <plist> element itself
  const root = next();
  if (root.name !== 'dict') fail('the plist does not hold a dictionary at its root');
  // `root.selfClosing`, not `false`: an intentionally empty file is written
  // `<dict/>`, and treating that as an open tag consumes the rest of the
  // document and blames `</plist>` — the error a real entitlements file
  // produced, three steps away from the cause.
  const value = parseValue('dict', root.selfClosing, root.end);
  return value as Record<string, PlistValue>;
}

/** A dotted path through nested dictionaries; an array yields its first entry. */
export function plistString(root: PlistValue, path: string, fallback: string): string {
  let value: PlistValue | undefined = root;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
    value = (value as Record<string, PlistValue>)[segment];
    if (value === undefined) return fallback;
  }
  if (Array.isArray(value)) value = value[0];
  if (typeof value === 'boolean') return String(value);
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * Read a plist that may be in either format.
 *
 * The archive's own Info.plist is XML, but the one inside the built `.app` is a
 * BINARY property list — Xcode converts it at copy time. `plutil` reads both,
 * and is on every Mac that has Xcode, so the text scanner above only ever sees
 * XML. Returns null when neither path works, and the caller decides whether
 * that is fatal.
 */
export function readPlistFile(boundary: Boundary, path: string): Record<string, PlistValue> | null {
  const raw = boundary.fs.read(path);
  if (raw.includes('<plist')) return parsePlist(raw);
  const converted = boundary.exec.runSync('plutil', ['-convert', 'xml1', '-o', '-', path], {
    allowFail: true,
  });
  return converted.ok && converted.stdout.includes('<plist') ? parsePlist(converted.stdout) : null;
}
