/**
 * `jetbridge.config.json` — one schema, three jobs: the TypeScript types, the
 * runtime validator, and the published JSON Schema editors autocomplete
 * against. Defining it three times is how they drift.
 *
 * Every value here was a hardcoded constant in the tool this package was
 * extracted from. Nothing project-specific is allowed back in as a default.
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

const identifier = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a plain identifier');

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), 'must be relative to the project root')
  .refine((p) => !p.split('/').includes('..'), 'must not escape the project root');

const entitlementPair = z.object({
  /** The Xcode target this pair belongs to — one app, plus any extensions. */
  target: z.string().min(1),
  /** Shipping entitlements, used by a plain build. */
  base: relativePath,
  /** Reduced entitlements for a variant bundle id. */
  variant: relativePath,
});

const projectSchema = z.object({
  /** Directory holding the Xcode project, relative to the config file. */
  iosDir: relativePath.default('.'),
  /** `.xcodeproj` name, relative to `iosDir`. */
  xcodeproj: z.string().min(1).endsWith('.xcodeproj').optional(),
  /** `.xcworkspace` name, relative to `iosDir`. Takes precedence when set. */
  xcworkspace: z.string().min(1).endsWith('.xcworkspace').optional(),
  scheme: z.string().min(1),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/, 'an Apple team id is 10 uppercase alphanumerics'),
  baseBundleId: z
    .string()
    .regex(
      /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
      'a reverse-DNS bundle id, e.g. com.example.app.dev',
    ),
  /** XcodeGen spec, relative to `iosDir`. Only set when the project is generated. */
  projectYml: relativePath.optional(),
  /** Re-run XcodeGen before building. Requires `projectYml`. */
  xcodegen: z.boolean().default(false),
  /** Icon shown on the OTA install page, relative to the project root. */
  appIcon: relativePath.optional(),
});

const configurationsSchema = z.object({
  /** Build configurations that exist in the project. Validated before building. */
  available: z.array(z.string().min(1)).min(1).default(['Debug', 'Release']),
  /** Cabled installs default to a debuggable build — it is the inner loop. */
  wired: z.string().min(1).default('Debug'),
  sim: z.string().min(1).default('Debug'),
  /** Archives default to the optimised build, since they go to other people. */
  archive: z.string().min(1).default('Release'),
});

const variantSchema = z.object({
  /** Home-screen label for a plain build, e.g. what the project already sets. */
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
  entitlements: z.array(entitlementPair).default([]),
});

const xcconfigOverrideSchema = z.object({
  /** Git-ignored xcconfig the build already `#include?`s, relative to the project root. */
  file: relativePath,
  /** Build setting to rewrite, e.g. an API base URL. */
  key: identifier,
  /** Named shortcuts, exposed as `--<name>` on the build commands. */
  presets: z.record(z.string(), z.string()).prefault({}),
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
  ascKeyId: identifier.default('ASC_API_KEY_ID'),
  ascIssuerId: identifier.default('ASC_API_ISSUER_ID'),
  ascKeyPath: identifier.default('ASC_API_KEY_PATH'),
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
  accessKeyId: identifier.default('JETBRIDGE_S3_ACCESS_KEY_ID'),
  secretAccessKey: identifier.default('JETBRIDGE_S3_SECRET_ACCESS_KEY'),
});

const otaSchema = z.object({
  storage: otaStorageSchema,
  exportMethod: z.enum(['ad-hoc', 'enterprise']).default('ad-hoc'),
  /** Builds kept on the index page before the oldest is dropped. */
  maxBuilds: z.number().int().positive().max(500).default(60),
  /** `path` puts an unguessable token in the URL; `none` assumes a private bucket. */
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
    xcconfigOverrides: xcconfigOverrideSchema.optional(),
    hooks: hooksSchema.prefault({}),
    credentials: credentialsSchema.prefault({}),
    ota: otaSchema.optional(),
    git: gitSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    const { available, wired, sim, archive } = config.configurations;
    for (const [field, value] of Object.entries({ wired, sim, archive })) {
      if (!available.includes(value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configurations', field],
          message: `"${value}" is not in configurations.available (${available.join(', ')})`,
        });
      }
    }
    if (config.project.xcodegen && !config.project.projectYml) {
      ctx.addIssue({
        code: 'custom',
        path: ['project', 'projectYml'],
        message:
          'project.xcodegen is on, so project.projectYml must say which spec to generate from',
      });
    }
    if (!config.project.xcodeproj && !config.project.xcworkspace) {
      ctx.addIssue({
        code: 'custom',
        path: ['project', 'xcodeproj'],
        message: 'set project.xcodeproj or project.xcworkspace',
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ProjectConfig = Config['project'];
export type OtaConfig = NonNullable<Config['ota']>;
export type EntitlementPair = z.infer<typeof entitlementPair>;

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
