/**
 * `jetbridge.config.json` — one schema, three jobs: the TypeScript types, the
 * runtime validator, and the published JSON Schema editors autocomplete
 * against. Defining it three times is how they drift.
 *
 * Every value here was a hardcoded constant in the tool this package was
 * extracted from. Nothing project-specific is allowed back in as a default.
 *
 * A field that merely REPEATS the Xcode project does not belong here — it goes
 * stale, and a stale copy refuses a build that works or patches a line that
 * moved. Those are read from the project instead (see `xcodeproject.ts`).
 *
 * `project.teamId`, `project.baseBundleId` and `variant.displayName` look like
 * exactly that and are NOT. They are the DEV build's identity, which is
 * deliberately different from what the project declares for a release build: a
 * separate bundle id so both can be installed at once, its own home-screen
 * label, and sometimes another development team. Deriving them from the
 * project would produce a dev build indistinguishable from the shipping one,
 * which is the problem this tool exists to solve. Do not delete them.
 */
import { z } from 'zod';

export const CONFIG_FILENAMES = ['jetbridge.config.json', '.jetbridge.json'] as const;
export const CONFIG_VERSION = 1;

/** Leading words that carry no meaning in a variant name. */
export const COMMIT_TYPE_NOISE = [
  'feat',
  'fix',
  'chore',
  'refactor',
  'docs',
  'perf',
  'test',
  'ci',
  'build',
  'style',
  'worktree',
] as const;

/**
 * A reference to an environment variable, never a value.
 *
 * `"OTA_KEY_ID"` reads as either a variable name or the secret itself, and the
 * config file is committed — so the shape has to be unmistakable. `${VAR}` is
 * the convention people already know from docker-compose, GitHub Actions and
 * VS Code, and a bare string is rejected rather than guessed at.
 */
const envRef = z
  .string()
  .regex(
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/,
    'must reference an environment variable as "${VAR}" — never the value itself',
  );

/** `${VAR}` → `VAR`. */
export const envRefName = (ref: string): string => ref.slice(2, -1);

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), 'must be relative to the project root')
  .refine((p) => !p.split('/').includes('..'), 'must not escape the project root');

/**
 * An Xcode target that gets its own bundle id — the app, plus any extension
 * that ships inside it. An extension's id is the app's id plus its own segment,
 * which is why a variant has to register more than one.
 */
const targetSchema = z.object({
  /**
   * Xcode target name, as the project spells it.
   *
   * A SELECTION, not a duplication: a project has test targets and extensions
   * that must not get variant treatment, and naming the ones that do is a
   * decision nothing on disk can make. Everything else about a target — its
   * bundle id, its entitlements — is read from the project.
   */
  name: z.string().min(1),
  /**
   * Reduced entitlements for a variant. Capabilities the public API cannot
   * grant (app groups, Sign in with Apple) have to be dropped here, or signing
   * fails against a profile that does not carry them.
   *
   * Relative to the PROJECT ROOT — this config file's directory — like every
   * other path here, and NOT to the Xcode project directory the way
   * `CODE_SIGN_ENTITLEMENTS` is spelled. In practice it sits beside the
   * shipping entitlements file the target already points at, so it takes that
   * file's directory with `iosDir` on the front: a target pointing at
   * `Acme/Acme.entitlements` wants `ios/Acme/Acme-variant.entitlements` here.
   * The file has to exist, and a variant build says so before it builds.
   */
  variantEntitlements: relativePath.optional(),
});

const projectSchema = z.object({
  /** Directory holding the Xcode project, relative to the config file. */
  iosDir: relativePath.default('.'),
  /**
   * `.xcodeproj` name, relative to `iosDir`. Inferred when the directory holds
   * exactly one; set it only to settle which of several to build.
   */
  xcodeproj: z.string().min(1).endsWith('.xcodeproj').optional(),
  /** `.xcworkspace` name, relative to `iosDir`. Takes precedence when set. */
  xcworkspace: z.string().min(1).endsWith('.xcworkspace').optional(),
  /** A real choice: a project with more than one scheme cannot pick for you. */
  scheme: z.string().min(1),
  /** The team a DEV build signs with — deliberately allowed to differ from the project's. */
  teamId: z.string().regex(/^[A-Z0-9]{10}$/, 'an Apple team id is 10 uppercase alphanumerics'),
  /** The dev build's own identity, not the id the project ships under. */
  baseBundleId: z
    .string()
    .regex(
      /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
      'a reverse-DNS bundle id, e.g. com.example.app.dev',
    ),
  /**
   * Re-run XcodeGen before building. A real choice — the spec is found beside
   * the project, but whether to regenerate from it on every build is not
   * something the directory can answer.
   */
  xcodegen: z.boolean().default(false),
  /** Icon shown on the OTA install page, relative to the project root. */
  appIcon: relativePath.optional(),
  /**
   * Device types a cabled install targets. `devicectl` reports an iPad's
   * platform as `iOS` too, so a platform check would sweep a paired iPad into
   * the install set of an iPhone-only app.
   */
  deviceTypes: z
    .array(z.enum(['iPhone', 'iPad']))
    .min(1)
    .default(['iPhone']),
});

/**
 * Which configuration each destination builds. Not WHICH EXIST — that is in the
 * pbxproj, and a second copy here goes stale and refuses a build that works.
 * Each of these is checked against the project itself at build time.
 */
const configurationsSchema = z.object({
  /** Cabled installs default to a debuggable build — it is the inner loop. */
  wired: z.string().min(1).default('Debug'),
  sim: z.string().min(1).default('Debug'),
  /** Archives default to the optimised build, since they go to other people. */
  archive: z.string().min(1).default('Release'),
});

const variantSchema = z.object({
  /**
   * Home-screen label for a plain build. The dev build's identity, deliberately
   * allowed to differ from what the project declares for release.
   */
  displayName: z.string().min(1),
  /** Prefix for a variant label: `<prefix> Seeded Feed`. Defaults to displayName's first word. */
  labelPrefix: z.string().min(1).optional(),
  /** iOS truncates a home-screen label at roughly this many characters. */
  labelBudget: z.number().int().positive().default(14),
  /**
   * Leading words dropped from a variant name. Defaults to conventional-commit
   * types plus the segments of `baseBundleId`, so pasting the bundle id back in
   * does not produce a name that stutters.
   */
  noiseWords: z.array(z.string().min(1)).optional(),
  /** Every target that needs its own registered bundle id. */
  targets: z.array(targetSchema).default([]),
});

const hooksSchema = z.object({
  /**
   * Shell commands run in the project root. JSON cannot hold a function; this
   * is the deliberate cost of a config file a wizard can write and a human can
   * read.
   */
  preBuild: z.string().min(1).optional(),
  postBuild: z.string().min(1).optional(),
});

const credentialsSchema = z.object({
  /** Environment variable NAMES. A secret never belongs in this file. */
  ascKeyId: envRef.default('${ASC_API_KEY_ID}'),
  ascIssuerId: envRef.default('${ASC_API_ISSUER_ID}'),
  ascKeyPath: envRef.default('${ASC_API_KEY_PATH}'),
});

const otaStorageSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1).default('us-east-1'),
  /** Set for S3-compatible hosts (R2, MinIO, Backblaze). Omit for AWS. */
  endpoint: z.string().url().optional(),
  /**
   * Where the uploaded objects are readable from. `itms-services` refuses
   * anything but HTTPS with a valid certificate, so this is checked, not
   * trusted.
   */
  publicBaseUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'must be https:// — iOS refuses to install over http'),
  prefix: z.string().default('builds'),
  accessKeyId: envRef.default('${JETBRIDGE_S3_ACCESS_KEY_ID}'),
  secretAccessKey: envRef.default('${JETBRIDGE_S3_SECRET_ACCESS_KEY}'),
});

const otaSchema = z.object({
  storage: otaStorageSchema,
  /**
   * `development` is the default, and it is not a compromise: it produces an
   * .ipa that installs over the air on every device named in the profile, and
   * it signs with the development certificate every Apple developer already
   * has. `ad-hoc` and `enterprise` need a DISTRIBUTION certificate, which not
   * every team member holds — asking for one without it fails inside Apple's
   * API with a message about "no current certificates ... compatible with".
   */
  exportMethod: z.enum(['development', 'ad-hoc', 'enterprise']).default('development'),
  /** Builds kept on the index page before the oldest is dropped. */
  maxBuilds: z.number().int().positive().max(500).default(60),
  /**
   * Who can reach a build URL.
   *
   * `path` puts an unguessable segment in every key, so someone at the bucket
   * root finds nothing to browse — the URL itself is the secret, which is the
   * only shape that works here: iOS fetches the manifest and the .ipa with no
   * auth header, and a presigned URL would expire inside a page meant to stay
   * bookmarkable for weeks.
   *
   * `none` gives short, stable, readable URLs. Correct when the bucket is
   * already private and fronted by something that authenticates, or when the
   * builds simply are not sensitive. It is a real choice, not a lesser one.
   */
  access: z.enum(['path', 'none']).default('path'),
  branding: z
    .object({
      title: z.string().min(1).optional(),
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'a six-digit hex colour')
        .optional(),
    })
    .prefault({}),
});

const gitSchema = z.object({
  /** Repos disagree: main, master, trunk. */
  defaultBranch: z.string().min(1).default('main'),
  /** The remote to read branches from. Not every checkout calls it `origin`. */
  remote: z.string().min(1).default('origin'),
  /**
   * A plain (non-variant) install overwrites the app every session shares, so
   * its provenance has to be knowable. Off by default — it is a strong
   * convention, not a universal one.
   */
  requireCleanDefaultBranch: z.boolean().default(false),
});

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    configVersion: z.literal(CONFIG_VERSION),
    project: projectSchema,
    configurations: configurationsSchema.prefault({}),
    variant: variantSchema,
    hooks: hooksSchema.prefault({}),
    credentials: credentialsSchema.prefault({}),
    ota: otaSchema.optional(),
    git: gitSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    // Everything else a target claims — its bundle id, whether it is the app —
    // is read from the pbxproj, where a contradiction is a project error and is
    // reported against the project rather than against this file.
    const names = config.variant.targets.map((target) => target.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['variant', 'targets'],
        message: `two targets share the name "${duplicate}"`,
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ProjectConfig = Config['project'];
export type OtaConfig = NonNullable<Config['ota']>;
export type TargetConfig = z.infer<typeof targetSchema>;

/**
 * The noise words actually used: whatever was configured, or the default —
 * commit types plus the segments of the base bundle id.
 */
export function noiseWordsFor(config: Config): Set<string> {
  const configured = config.variant.noiseWords;
  if (configured) return new Set(configured.map((w) => w.toLowerCase()));
  return new Set([
    ...COMMIT_TYPE_NOISE,
    ...config.project.baseBundleId.split('.').map((s) => s.toLowerCase()),
  ]);
}

/** `Acme Dev` → `Acme`, unless a prefix was set explicitly. */
export function labelPrefixFor(config: Config): string {
  return config.variant.labelPrefix ?? config.variant.displayName.split(/\s+/)[0]!;
}

export interface ConfigError {
  path: string;
  message: string;
}

export type ParseResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

/** Validate an already-parsed object. Separated so the wizard can check its own draft. */
export function parseConfig(value: unknown): ParseResult {
  const result = configSchema.safeParse(value);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

export function formatConfigErrors(errors: ConfigError[]): string {
  return errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
}

/** The published JSON Schema, generated from the same definition the runtime uses. */
export function jsonSchema(): unknown {
  return z.toJSONSchema(configSchema, { io: 'input', unrepresentable: 'any' });
}
