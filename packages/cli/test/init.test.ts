/**
 * The wizard is the only thing that writes a config file, so it is checked the
 * way the file is used: every run ends by reading what was written back through
 * `parseConfig`, and the tests assert on the bytes on disk.
 *
 * No TTY, no network, no Xcode — the prompts come from a script, the project
 * comes from the fake filesystem, and the bucket round trip is a stub.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  assembleConfig,
  commandPreviews,
  detectDrift,
  runInit,
  serializeConfig,
  type InitOptions,
  type OtaRoundTrip,
} from '../src/init.js';
import { detectProject } from '../src/detect.js';
import { projectFrom } from '../src/project.js';
import { scriptedPrompter, type ScriptedPrompter } from '../src/prompts.js';
import {
  fakeBoundary,
  type FakeBoundary,
  type FakeBoundaryOptions,
} from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';

/* -------------------------------------------------------------------------- */
/* A project on the fake filesystem                                           */
/* -------------------------------------------------------------------------- */

/** Just enough pbxproj for the wizard to have something to detect. */
function pbxproj(options: { configurations: string[]; bundleId: string }): string {
  const projectConfig = (name: string, index: number) => `
		P0${index} /* ${name} */ = {
			isa = XCBuildConfiguration;
			buildSettings = { DEVELOPMENT_TEAM = ABCDE12345; };
			name = ${name};
		};`;
  const targetConfig = (name: string, index: number) => `
		T0${index} /* ${name} */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				INFOPLIST_KEY_CFBundleDisplayName = "Acme Dev";
				PRODUCT_BUNDLE_IDENTIFIER = ${options.bundleId};
			};
			name = ${name};
		};`;
  return `// !$*UTF8*$!
{
	objects = {
		A01 /* Acme */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = C02 /* list */;
			name = Acme;
			productType = "com.apple.product-type.application";
		};
		R01 /* Project object */ = {
			isa = PBXProject;
			buildConfigurationList = C01 /* list */;
			targets = ( A01 /* Acme */, );
		};${options.configurations.map(projectConfig).join('')}${options.configurations
      .map(targetConfig)
      .join('')}
		C01 /* list */ = {
			isa = XCConfigurationList;
			buildConfigurations = ( ${options.configurations.map((_, index) => `P0${index}`).join(', ')} );
		};
		C02 /* list */ = {
			isa = XCConfigurationList;
			buildConfigurations = ( ${options.configurations.map((_, index) => `T0${index}`).join(', ')} );
		};
	};
	rootObject = R01 /* Project object */;
}
`;
}

const projectFiles = (
  options: { configurations?: string[]; bundleId?: string } = {},
): Record<string, string> => ({
  '/repo/ios/Acme.xcodeproj/project.pbxproj': pbxproj({
    configurations: options.configurations ?? ['Debug', 'Release'],
    bundleId: options.bundleId ?? 'io.acme.app.dev',
  }),
  '/repo/ios/Acme.xcodeproj/xcshareddata/xcschemes/Acme.xcscheme': '<Scheme/>',
});

/** The fake boundary keeps its log to itself; several tests assert on it. */
interface InitHarness {
  boundary: FakeBoundary;
  logs: string[];
}

function harness(options: FakeBoundaryOptions = {}): InitHarness {
  const logs: string[] = [];
  const base = fakeBoundary({
    cwd: '/repo',
    interactive: true,
    files: projectFiles(),
    env: { ASC_API_KEY_ID: 'SENTINEL-KEY-ID-VALUE', ASC_API_ISSUER_ID: 'SENTINEL-ISSUER-VALUE' },
    ...options,
  });
  const boundary: FakeBoundary = {
    ...base,
    log: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
      step: (m) => logs.push(m),
    },
  };
  return { boundary, logs };
}

/** Every question a plain interactive run asks, answered. */
const fullAnswers = {
  'project.iosDir': 'ios',
  'project.scheme': 'Acme',
  'project.teamId': 'ABCDE12345',
  'project.baseBundleId': 'io.acme.app.dev',
  'variant.displayName': 'Acme Dev',
  'credentials.ascKeyId': 'ASC_API_KEY_ID',
  'credentials.ascIssuerId': 'ASC_API_ISSUER_ID',
  'ota.enabled': false,
  write: true,
};

const written = (boundary: FakeBoundary): string => {
  const value = boundary.files.get('/repo/jetbridge.config.json');
  if (typeof value !== 'string') throw new Error('nothing was written');
  return value;
};

const run = async (
  harnessed: InitHarness,
  answers: Record<string, string | boolean>,
  options: InitOptions = {},
  otaRoundTrip?: OtaRoundTrip,
): Promise<{ prompts: ScriptedPrompter; result: Awaited<ReturnType<typeof runInit>> }> => {
  const prompts = scriptedPrompter(answers);
  const result = await runInit(harnessed.boundary, options, {
    prompts,
    ...(otaRoundTrip ? { otaRoundTrip } : {}),
  });
  return { prompts, result };
};

/* -------------------------------------------------------------------------- */

describe('assembleConfig', () => {
  const input = {
    iosDir: 'ios',
    xcodeproj: 'Acme.xcodeproj',
    scheme: 'Acme',
    teamId: 'ABCDE12345',
    baseBundleId: 'io.acme.app.dev',
    configurations: {
      available: ['Debug', 'Release'],
      wired: 'Debug',
      sim: 'Debug',
      archive: 'Release',
    },
    displayName: 'Acme Dev',
    targets: [{ name: 'Acme' }],
    credentials: { ascKeyId: 'ASC_API_KEY_ID', ascIssuerId: 'ASC_API_ISSUER_ID' },
  };

  it('produces a config the tool accepts', () => {
    expect(parseConfig(assembleConfig(input)).ok).toBe(true);
  });

  it('stamps the schema and the config version', () => {
    const raw = assembleConfig(input) as Record<string, unknown>;
    expect(raw.$schema).toMatch(/schema\/v1\.json$/);
    expect(raw.configVersion).toBe(1);
  });

  it('writes the keys in schema order, with a trailing newline', () => {
    const text = serializeConfig(assembleConfig(input));
    expect(Object.keys(assembleConfig(input))).toEqual([
      '$schema',
      'configVersion',
      'project',
      'configurations',
      'variant',
      'credentials',
    ]);
    expect(text.endsWith('}\n')).toBe(true);
  });
});

describe('commandPreviews', () => {
  it('shows the scheme, configuration and destination each mode will use', () => {
    const project = projectFrom('/repo/jetbridge.config.json', testConfig());
    expect(commandPreviews(project)).toEqual([
      {
        mode: 'wired',
        command:
          'xcodebuild build -project /repo/ios/Acme.xcodeproj -scheme Acme -configuration Debug ' +
          '-destination generic/platform=iOS',
      },
      {
        mode: 'sim',
        command:
          'xcodebuild build -project /repo/ios/Acme.xcodeproj -scheme Acme -configuration Debug ' +
          "-destination 'platform=iOS Simulator'",
      },
      {
        mode: 'archive',
        command:
          'xcodebuild archive -project /repo/ios/Acme.xcodeproj -scheme Acme -configuration ' +
          'Release -destination generic/platform=iOS',
      },
    ]);
  });
});

describe('the interactive flow', () => {
  it('writes a config the tool accepts, and proves it by reading it back', async () => {
    const h = harness();
    const { result } = await run(h, fullAnswers);
    expect(result.status).toBe('written');
    expect(result.config?.project.scheme).toBe('Acme');
    expect(parseConfig(JSON.parse(written(h.boundary))).ok).toBe(true);
  });

  it('shows every detected value as a default instead of accepting it silently', async () => {
    const h = harness();
    const prompts = scriptedPrompter(fullAnswers);
    const asked: string[] = [];
    const spy = {
      ...prompts,
      text: async (question: Parameters<typeof prompts.text>[0]) => {
        asked.push(`${question.name}=${question.initial ?? ''}:${question.hint ?? ''}`);
        return prompts.text(question);
      },
    };
    await runInit(h.boundary, {}, { prompts: spy });
    expect(asked).toContain('project.teamId=ABCDE12345:from ios/Acme.xcodeproj/project.pbxproj');
    expect(asked).toContain(
      'project.baseBundleId=io.acme.app.dev:from ios/Acme.xcodeproj/project.pbxproj',
    );
  });

  it('does not ask about a build configuration it can infer', async () => {
    const h = harness();
    const { prompts } = await run(h, fullAnswers);
    expect(prompts.asked).not.toContain('configurations.wired');
    expect(JSON.parse(written(h.boundary)).configurations).toEqual({
      available: ['Debug', 'Release'],
      wired: 'Debug',
      sim: 'Debug',
      archive: 'Release',
    });
  });

  it('asks which configuration to use when the project has no Debug', async () => {
    const h = harness({ files: projectFiles({ configurations: ['Dev', 'Staging', 'Prod'] }) });
    const { prompts, result } = await run(h, {
      ...fullAnswers,
      'configurations.wired': 'Dev',
      'configurations.sim': 'Dev',
      'configurations.archive': 'Prod',
    });
    expect(prompts.asked).toContain('configurations.wired');
    expect(result.config?.configurations).toEqual({
      available: ['Dev', 'Staging', 'Prod'],
      wired: 'Dev',
      sim: 'Dev',
      archive: 'Prod',
    });
  });

  it('carries the detected targets into the variant section', async () => {
    const h = harness();
    const { result } = await run(h, fullAnswers);
    expect(result.config?.variant.targets.map((t) => t.name)).toEqual(['Acme']);
  });

  it('writes nothing when the dry run is declined', async () => {
    const h = harness();
    const { result } = await run(h, { ...fullAnswers, write: false });
    expect(result.status).toBe('declined');
    expect(h.boundary.writes).toEqual([]);
    expect(h.boundary.files.has('/repo/jetbridge.config.json')).toBe(false);
  });

  it('shows the file and the commands before asking to write', async () => {
    const h = harness();
    const { prompts } = await run(h, fullAnswers);
    expect(prompts.notes.join('\n')).toContain('"configVersion": 1');
    expect(h.logs.join('\n')).toContain('-destination generic/platform=iOS');
  });
});

describe('credentials', () => {
  it('stores the variable names and never the values behind them', async () => {
    const h = harness();
    await run(h, fullAnswers);
    const text = written(h.boundary);
    expect(JSON.parse(text).credentials).toEqual({
      ascKeyId: 'ASC_API_KEY_ID',
      ascIssuerId: 'ASC_API_ISSUER_ID',
    });
    expect(text).not.toContain('SENTINEL-KEY-ID-VALUE');
    expect(text).not.toContain('SENTINEL-ISSUER-VALUE');
  });

  it('warns, but does not fail, when a name does not resolve today', async () => {
    const h = harness({ env: {} });
    const { result } = await run(h, fullAnswers);
    expect(result.status).toBe('written');
    expect(h.logs.join('\n')).toContain('ASC_API_KEY_ID is not set in this environment');
    expect(h.logs.join('\n')).toContain('ASC_API_ISSUER_ID is not set in this environment');
  });

  it('warns when the names resolve but the private key is nowhere on the search path', async () => {
    // `credentials.ascKeyPath` is never asked for — the key is found by search —
    // so this is the only place a missing key file surfaces before a build.
    const h = harness();
    await run(h, fullAnswers);
    expect(h.logs.join('\n')).toContain('App Store Connect credentials are not configured');
  });

  it('says nothing about credentials when the key is where it should be', async () => {
    const h = harness({
      homedir: '/home/dev',
      files: {
        ...projectFiles(),
        '/home/dev/.appstoreconnect/private_keys/AuthKey_SENTINEL-KEY-ID-VALUE.p8': 'KEY',
      },
    });
    await run(h, fullAnswers);
    expect(h.logs.join('\n')).not.toContain('credentials are not configured');
  });
});

describe('over-the-air delivery', () => {
  const otaAnswers = {
    ...fullAnswers,
    'ota.enabled': true,
    'ota.storage.bucket': 'acme-builds',
    'ota.storage.region': 'eu-central-1',
    'ota.storage.endpoint': '',
    'ota.storage.publicBaseUrl': 'https://builds.example.com',
  };

  it('is left out entirely when it is not taken', async () => {
    const h = harness();
    const { result } = await run(h, fullAnswers);
    expect(result.config?.ota).toBeUndefined();
    expect(written(h.boundary)).not.toContain('"ota"');
  });

  it('round-trips the bucket before writing anything', async () => {
    const h = harness();
    const seen: unknown[] = [];
    const check: OtaRoundTrip = async (_boundary, storage) => {
      seen.push(storage);
      return { ok: true, detail: 'uploaded, fetched back and deleted a test object' };
    };
    const { result } = await run(h, otaAnswers, {}, check);
    expect(seen).toEqual([
      {
        bucket: 'acme-builds',
        region: 'eu-central-1',
        publicBaseUrl: 'https://builds.example.com',
        prefix: 'builds',
      },
    ]);
    expect(result.config?.ota?.storage.bucket).toBe('acme-builds');
    expect(h.logs.join('\n')).toContain('uploaded, fetched back and deleted');
  });

  it('warns and offers to continue when the round trip fails', async () => {
    const h = harness();
    const check: OtaRoundTrip = async () => ({ ok: false, detail: '403 from the public URL' });
    const { result } = await run(h, { ...otaAnswers, 'ota.continue': true }, {}, check);
    expect(h.logs.join('\n')).toContain('could not be verified: 403 from the public URL');
    expect(result.status).toBe('written');
    expect(result.config?.ota?.storage.publicBaseUrl).toBe('https://builds.example.com');
  });

  it('writes nothing when a failed round trip is not accepted', async () => {
    const h = harness();
    const check: OtaRoundTrip = async () => ({ ok: false, detail: 'no such bucket' });
    const { result } = await run(h, { ...otaAnswers, 'ota.continue': false }, {}, check);
    expect(result.status).toBe('declined');
    expect(h.boundary.writes).toEqual([]);
  });

  it('treats a missing checker as a failed check, not as a pass', async () => {
    const h = harness();
    const { result } = await run(h, { ...otaAnswers, 'ota.continue': false });
    expect(h.logs.join('\n')).toContain('no checker was wired in');
    expect(result.status).toBe('declined');
  });

  it('refuses to write a bucket that failed its round trip under --yes', async () => {
    // Nobody can overrule the check behind a pipe, and a config that cannot
    // deliver is worse than a non-zero exit.
    const h = harness();
    const check: OtaRoundTrip = async () => ({ ok: false, detail: '403 from the public URL' });
    await expect(
      run(
        h,
        {},
        {
          yes: true,
          ota: true,
          otaBucket: 'acme-builds',
          otaPublicBaseUrl: 'https://builds.example.com',
        },
        check,
      ),
    ).rejects.toThrow(/the OTA round trip failed: 403 from the public URL[\s\S]*without --ota/);
    expect(h.boundary.writes).toEqual([]);
  });
});

describe('--yes', () => {
  it('asks nothing at all when everything can be inferred', async () => {
    const h = harness();
    const { prompts, result } = await run(h, {}, { yes: true });
    expect(prompts.asked).toEqual([]);
    expect(result.status).toBe('written');
    expect(result.config?.project.baseBundleId).toBe('io.acme.app.dev');
  });

  it('fails naming the flag that supplies what it could not infer', async () => {
    // A bundle id assembled from other build settings is not inferable, and
    // neither is the team id when nothing declares one.
    const h = harness({
      files: {
        ...projectFiles(),
        '/repo/ios/Acme.xcodeproj/project.pbxproj': pbxproj({
          configurations: ['Debug', 'Release'],
          bundleId: '"$(BUNDLE_PREFIX).app.dev"',
        }).replace(/DEVELOPMENT_TEAM = ABCDE12345;/g, ''),
      },
    });
    await expect(run(h, {}, { yes: true })).rejects.toThrow(
      /project\.teamId — pass --team-id[\s\S]*project\.baseBundleId — pass --bundle-id/,
    );
    expect(h.boundary.writes).toEqual([]);
  });

  it('names the configuration flag when the project has no Debug', async () => {
    const h = harness({ files: projectFiles({ configurations: ['Dev', 'Prod'] }) });
    await expect(run(h, {}, { yes: true })).rejects.toThrow(
      /configurations\.wired — pass --configuration-wired/,
    );
  });

  it('takes a value from a flag instead of the project', async () => {
    const h = harness();
    const { result } = await run(h, {}, { yes: true, teamId: 'ZZZZZ99999', scheme: 'Acme Prod' });
    expect(result.config?.project.teamId).toBe('ZZZZZ99999');
    expect(result.config?.project.scheme).toBe('Acme Prod');
  });

  it('rejects a flag value the schema would refuse, before writing', async () => {
    const h = harness();
    await expect(run(h, {}, { yes: true, teamId: 'nope' })).rejects.toThrow(/--team-id nope/);
    expect(h.boundary.writes).toEqual([]);
  });

  it('refuses to write behind a pipe without it', async () => {
    // The CI case: nothing to prompt with, so the consent has to be a flag.
    const h = harness({ interactive: false });
    await expect(run(h, {})).rejects.toThrow(/re-run with --yes/);
    expect(h.boundary.writes).toEqual([]);
  });
});

describe('detectDrift', () => {
  const detection = () =>
    detectProject(fakeBoundary({ cwd: '/repo', files: projectFiles() }), { root: '/repo' });

  it('finds nothing when the config still matches the project', () => {
    const config = testConfig({
      project: { scheme: 'Acme', teamId: 'ABCDE12345', baseBundleId: 'io.acme.app.dev' },
    });
    expect(detectDrift(config, detection())).toEqual([]);
  });

  it('reports a scheme the project no longer has', () => {
    const config = testConfig({ project: { scheme: 'Acme Old' } });
    const drift = detectDrift(config, detection());
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      path: 'project.scheme',
      current: 'Acme Old',
      detected: 'Acme',
    });
    expect(drift[0]!.note).toMatch(/no scheme named "Acme Old"/);
  });

  it('reports a build configuration that no longer exists', () => {
    const withDrift = detectProject(
      fakeBoundary({ cwd: '/repo', files: projectFiles({ configurations: ['Dev', 'Release'] }) }),
      { root: '/repo' },
    );
    const drift = detectDrift(testConfig(), withDrift);
    expect(drift.map((d) => d.path)).toContain('configurations.wired');
    expect(drift.find((d) => d.path === 'configurations.wired')!.note).toMatch(
      /no "Debug" build configuration any more/,
    );
  });

  it('carries the file that disagrees', () => {
    const drift = detectDrift(testConfig({ project: { teamId: 'ZZZZZ99999' } }), detection());
    expect(drift[0]!.source).toBe('ios/Acme.xcodeproj/project.pbxproj');
  });
});

describe('the repair pass', () => {
  /** A hand-written config, with a stale scheme and a section the schema does not know. */
  const existing = {
    $schema: 'https://unpkg.com/jetbridge/schema/v1.json',
    configVersion: 1,
    project: {
      iosDir: 'ios',
      xcodeproj: 'Acme.xcodeproj',
      scheme: 'Acme Old',
      teamId: 'ABCDE12345',
      baseBundleId: 'io.acme.app.dev',
      appIcon: 'ios/Acme/icon.png',
    },
    configurations: {
      available: ['Debug', 'Release'],
      wired: 'Debug',
      sim: 'Debug',
      archive: 'Release',
    },
    variant: { displayName: 'Acme Dev', labelBudget: 11, targets: [{ name: 'Acme' }] },
    hooks: { preBuild: 'npm run bundle' },
  };

  const withExisting = (config: unknown = existing): InitHarness =>
    harness({
      files: { ...projectFiles(), '/repo/jetbridge.config.json': serializeConfig(config) },
    });

  it('reports the drift instead of overwriting the file', async () => {
    const h = withExisting();
    const { result } = await run(h, { 'update:project.scheme': false });
    expect(result.drift.map((d) => d.path)).toEqual(['project.scheme']);
    expect(result.status).toBe('unchanged');
    expect(h.boundary.writes).toEqual([]);
    expect(h.logs.join('\n')).toContain('project.scheme: "Acme Old" → "Acme"');
  });

  it('updates only the fields that were accepted', async () => {
    const h = withExisting();
    const { result } = await run(h, { 'update:project.scheme': true, write: true });
    expect(result.status).toBe('written');
    const after = JSON.parse(written(h.boundary));
    expect(after.project.scheme).toBe('Acme');
    expect(after.project.appIcon).toBe('ios/Acme/icon.png');
    expect(after.variant.labelBudget).toBe(11);
    expect(after.hooks).toEqual({ preBuild: 'npm run bundle' });
  });

  it('leaves a section the file never had absent', async () => {
    const h = withExisting();
    await run(h, { 'update:project.scheme': true, write: true });
    const after = JSON.parse(written(h.boundary));
    expect(after.git).toBeUndefined();
    expect(after.credentials).toBeUndefined();
  });

  it('says so and changes nothing when the project still matches', async () => {
    const h = withExisting({ ...existing, project: { ...existing.project, scheme: 'Acme' } });
    const { prompts, result } = await run(h, {});
    expect(result.status).toBe('unchanged');
    expect(prompts.asked).toEqual([]);
    expect(h.boundary.writes).toEqual([]);
    expect(h.logs.join('\n')).toContain('still matches the project');
  });

  it('refuses to diff against a config it cannot read', async () => {
    const h = harness({
      files: { ...projectFiles(), '/repo/jetbridge.config.json': '{ "configVersion": 9 }' },
    });
    await expect(run(h, {})).rejects.toThrow(/already exists but jetbridge refuses it/);
    expect(h.boundary.writes).toEqual([]);
  });

  it('does not treat a config in a parent directory as this project', async () => {
    const h = harness({
      files: { ...projectFiles(), '/jetbridge.config.json': serializeConfig(existing) },
    });
    const { result } = await run(h, fullAnswers);
    expect(result.status).toBe('written');
    expect(result.configPath).toBe('/repo/jetbridge.config.json');
  });
});
