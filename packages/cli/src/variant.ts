/**
 * Naming a variant build.
 *
 * A variant gets its own bundle id and its own home-screen label, so two
 * branches install side by side as two distinguishable apps instead of
 * overwriting each other. Every name below comes from ONE parse of the raw
 * slug: derive the bundle-id segment and the label separately and they drift
 * (`feat/seeded-feed` became bundle `featseededfeed` but label "Seeded Feed").
 */
import { type Config, labelPrefixFor, noiseWordsFor } from './config.js';
import { fail } from './project.js';

/**
 * The words a variant is named from.
 *
 * Leading noise words are dropped, repeatedly: a conventional-commit type, and
 * the segments of the base bundle id someone might paste back in. So
 * `feat/seeded-feed` and `seeded-feed` name the same app, and
 * `com.example.dev.testtestes` yields `testtestes` rather than the absurd
 * `com.example.app.dev.comexampledevtesttestes`.
 *
 * Guarded on `length > 1` at each step, so an explicit `--suffix fix` still
 * names the variant "fix".
 */
export function variantWords(raw: string, noiseWords: Set<string>): string[] {
  const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  while (words.length > 1 && noiseWords.has(words[0]!.toLowerCase())) words.shift();
  if (words.length === 0) fail('a variant slug must contain letters or digits');
  return words;
}

/** Bundle-id segment and DNS label: lowercase alphanumerics only. */
export function sanitizeSuffix(raw: string, config: Config): string {
  return variantWords(raw, noiseWordsFor(config)).join('').toLowerCase();
}

/**
 * Human words for a variant, from the RAW slug — before `sanitizeSuffix`
 * collapses the separators a bundle id cannot carry. `seeded-feed` → `Seeded
 * Feed`; derive it from the collapsed `seededfeed` instead and you get
 * `Seededfeed`.
 */
export function variantTitle(raw: string, config: Config): string {
  return variantWords(raw, noiseWordsFor(config))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Interpolated into plist XML and a build setting — keep it boring. */
export function sanitizeName(raw: string): string {
  const name = raw.replace(/[^A-Za-z0-9 ._-]/g, '');
  if (!name) fail('a display name must contain letters or digits');
  return name;
}

/**
 * The name App Store Connect accepts for a bundle-id entity.
 *
 * Not the same string as the home-screen label, though it is derived from it.
 * iOS is happy with `CFBundleDisplayName = "Acme_Hello_World"`; the ASC API
 * rejects it outright:
 *
 *   409 ENTITY_ERROR.ATTRIBUTE.INVALID
 *   The attribute 'name' is invalid: 'Acme_Hello_World'
 *
 * Apple allows letters, digits and spaces there — not the `._-` a display name
 * permits. Punctuation becomes a space rather than vanishing, so
 * `Acme_Hello_World` reads `Acme Hello World`, not `AcmeHelloWorld`.
 */
export function ascEntityName(displayName: string): string {
  const name = displayName
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) fail(`cannot build an App Store Connect name from "${displayName}"`);
  return name;
}

export function bundleIdFor(suffix: string, config: Config): string {
  const base = config.project.baseBundleId;
  return suffix ? `${base}.${suffix}` : base;
}

/**
 * The home-screen label. An explicit name always wins; otherwise a variant gets
 * `<prefix> <Title>`, so two branches are never two identical icons. A plain
 * build keeps the project's own default.
 */
export function displayNameFor(rawSuffix: string, explicit: string, config: Config): string {
  if (explicit) return explicit;
  if (!rawSuffix) return config.variant.displayName;
  return `${labelPrefixFor(config)} ${variantTitle(rawSuffix, config)}`;
}

/** True when iOS will visibly truncate this label on the home screen. */
export function exceedsLabelBudget(label: string, config: Config): boolean {
  return label.length > config.variant.labelBudget;
}

/**
 * A slug is ONE bundle-id segment. A pasted bundle id is rejected rather than
 * quietly flattened: `--suffix com.example.dev.foo` used to build
 * `com.example.app.dev.comexampledevfoo`.
 */
export function assertSingleSegment(value: string, config: Config): string {
  if (value.includes('.')) {
    fail(
      `a variant slug is just the last segment — "${config.project.baseBundleId}.<slug>" is ` +
        'built for you (e.g. "wave")',
    );
  }
  return value;
}
