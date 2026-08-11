/**
 * The entitlement swap edits a tracked file in place and puts it back. Three
 * things are load-bearing and all are asserted literally here: the exact
 * spelling of the patched line (byte-identity is what keeps the build
 * incremental), that the original bytes always come back, and that BOTH sides
 * of the swap are spelled relative to the Xcode project directory.
 *
 * That last one is why the `from` side is read out of the project rather than
 * declared in the config. Two bases are in play — `CODE_SIGN_ENTITLEMENTS` is
 * relative to the Xcode project directory, a config path to the project root —
 * and a config written the way the schema documents produced a `from` that
 * matched nothing. It failed loudly, but blamed a stale project rather than the
 * spelling, so the fixtures here use the project's spelling throughout: one
 * written the convenient way passes while the real thing does not.
 */
import { describe, expect, it } from 'vitest';
import {
  applySwap,
  assertVariantEntitlements,
  codeSignLine,
  findStrandedSwap,
  pbxprojPath,
  swappableTargets,
  withEntitlementSwap,
} from '../src/entitlements.js';
import { projectFrom, type Project } from '../src/project.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary, type FakeBoundary } from './helpers/fake-boundary.js';
import { PBXPROJ_PATH as PATH_IN_REPO, pbxprojWith } from './helpers/pbxproj.js';

/** As the PROJECT spells them — relative to the Xcode project directory. */
const APP_SHIPPING = 'Acme/Acme.entitlements';
const APP_VARIANT = 'Acme/Acme-variant.entitlements';
const WIDGET_SHIPPING = 'Upload Widget/UploadWidget.entitlements';
const WIDGET_VARIANT = 'Widget/Widget-variant.entitlements';

/** The same two variant files as the CONFIG spells them — relative to the root. */
const APP_VARIANT_CONFIG = 'ios/Acme/Acme-variant.entitlements';
const WIDGET_VARIANT_CONFIG = 'ios/Widget/Widget-variant.entitlements';

const swappableConfig = {
  variant: {
    targets: [
      { name: 'Acme', variantEntitlements: APP_VARIANT_CONFIG },
      { name: 'Upload Widget', variantEntitlements: WIDGET_VARIANT_CONFIG },
    ],
  },
};

const projectOf = (overrides: Record<string, unknown> = {}): Project =>
  projectFrom('/w/jetbridge.config.json', testConfig(overrides));

const PBXPROJ_PATH = `/w/${PATH_IN_REPO}`;

/**
 * A project file with the given entitlements per target. It carries a file
 * reference naming the variant file too — that exists on disk in a clean
 * checkout, and must never read as a stranded swap.
 */
const pbxproj = (app?: string, widget?: string): string =>
  pbxprojWith({ Acme: app, 'Upload Widget': widget });

const CLEAN = pbxproj(APP_SHIPPING, WIDGET_SHIPPING);
const SWAPPED = pbxproj(APP_VARIANT, WIDGET_VARIANT);

const boundaryWithProject = (contents = CLEAN): FakeBoundary =>
  fakeBoundary({ files: { [PBXPROJ_PATH]: contents } });

describe('codeSignLine', () => {
  it('leaves a plain path bare', () => {
    expect(codeSignLine(APP_SHIPPING)).toBe('CODE_SIGN_ENTITLEMENTS = Acme/Acme.entitlements;');
  });

  it('quotes a path containing a hyphen, exactly as a generator spells it', () => {
    // Byte-identity with a regenerated project file is what keeps xcodebuild
    // from fingerprinting a change and rebuilding the world.
    expect(codeSignLine(APP_VARIANT)).toBe(
      'CODE_SIGN_ENTITLEMENTS = "Acme/Acme-variant.entitlements";',
    );
  });

  it('quotes any path a bare token cannot hold', () => {
    expect(codeSignLine('ios/My App/App.entitlements')).toBe(
      'CODE_SIGN_ENTITLEMENTS = "ios/My App/App.entitlements";',
    );
    // Underscore needs no quoting — a bare token holds it.
    expect(codeSignLine('a/b_c.entitlements')).toBe('CODE_SIGN_ENTITLEMENTS = a/b_c.entitlements;');
  });
});

describe('swappableTargets', () => {
  it('returns one pair per target declaring both files', () => {
    expect(swappableTargets(boundaryWithProject(), projectOf(swappableConfig), 'Debug')).toEqual([
      { target: 'Acme', from: APP_SHIPPING, to: APP_VARIANT },
      { target: 'Upload Widget', from: WIDGET_SHIPPING, to: WIDGET_VARIANT },
    ]);
  });

  it('skips a target the config gives no variant file for', () => {
    const project = projectOf({ variant: { targets: [{ name: 'Acme' }] } });
    expect(swappableTargets(boundaryWithProject(), project, 'Debug')).toEqual([]);
  });

  it('skips a target the PROJECT declares no entitlements for', () => {
    // Nothing to swap FROM. Before this was derived, the config claimed a path
    // the project never spelled and the swap failed mid-build instead.
    const boundary = boundaryWithProject(pbxproj(undefined, WIDGET_SHIPPING));
    expect(swappableTargets(boundary, projectOf(swappableConfig), 'Debug')).toEqual([
      { target: 'Upload Widget', from: WIDGET_SHIPPING, to: WIDGET_VARIANT },
    ]);
  });

  it('reads the configuration the build will use', () => {
    // Debug and Release may name different files; the swap has to match the
    // line that build actually compiles against.
    const boundary = boundaryWithProject();
    expect(swappableTargets(boundary, projectOf(swappableConfig), 'Release')).toEqual([
      { target: 'Acme', from: APP_SHIPPING, to: APP_VARIANT },
      { target: 'Upload Widget', from: WIDGET_SHIPPING, to: WIDGET_VARIANT },
    ]);
  });

  it('is empty for a project with no targets at all', () => {
    expect(swappableTargets(boundaryWithProject(), projectOf(), 'Debug')).toEqual([]);
  });
});

describe('assertVariantEntitlements', () => {
  const onDisk = (...paths: string[]): FakeBoundary =>
    fakeBoundary({ files: Object.fromEntries(paths.map((path) => [path, '<plist/>'])) });

  it('passes when every declared file is where the config says', () => {
    const boundary = onDisk(`/w/${APP_VARIANT_CONFIG}`, `/w/${WIDGET_VARIANT_CONFIG}`);
    expect(() => assertVariantEntitlements(boundary, projectOf(swappableConfig))).not.toThrow();
  });

  it('quotes the ABSOLUTE path it looked at, which is what makes the mistake obvious', () => {
    // The mistake this exists for: spelling the path the way the pbxproj does
    // (`Acme/Acme-variant.entitlements`) when it is relative to the config.
    const project = projectOf({
      variant: {
        targets: [{ name: 'Acme', variantEntitlements: 'Acme/Acme-variant.entitlements' }],
      },
    });
    expect(() => assertVariantEntitlements(onDisk(`/w/${APP_VARIANT_CONFIG}`), project)).toThrow(
      /but there is no file there:\n {2}\/w\/Acme\/Acme-variant\.entitlements/,
    );
  });

  it('says what the path is relative to, and shows the shape that works', () => {
    const project = projectOf({
      variant: {
        targets: [{ name: 'Acme', variantEntitlements: 'Acme/Acme-variant.entitlements' }],
      },
    });
    expect(() => assertVariantEntitlements(fakeBoundary(), project)).toThrow(
      /relative to this config file, not to the Xcode project directory[\s\S]*ios\/Acme\/Acme-variant\.entitlements/,
    );
  });

  it('names every target that is wrong, not just the first', () => {
    expect(() => assertVariantEntitlements(fakeBoundary(), projectOf(swappableConfig))).toThrow(
      /declared for Acme, Upload Widget/,
    );
  });

  it('has nothing to say when no target asks for a swap', () => {
    expect(() => assertVariantEntitlements(fakeBoundary(), projectOf())).not.toThrow();
  });
});

describe('pbxprojPath', () => {
  it('points inside the Xcode project directory', () => {
    expect(pbxprojPath(projectOf())).toBe(PBXPROJ_PATH);
  });
});

describe('applySwap', () => {
  it('rewrites every declared pair', () => {
    const boundary = boundaryWithProject();
    applySwap(boundary, projectOf(swappableConfig), 'Debug');
    expect(boundary.fs.read(PBXPROJ_PATH)).toBe(SWAPPED);
  });

  it('writes the project-relative path, not the root-relative one', () => {
    // The bug this replaced: the config said `ios/Acme/…` and the project said
    // `Acme/…`, so `replaceAll` matched nothing and the swap failed mid-build.
    const boundary = boundaryWithProject();
    applySwap(boundary, projectOf(swappableConfig), 'Debug');
    const after = boundary.fs.read(PBXPROJ_PATH);
    expect(after).toContain('CODE_SIGN_ENTITLEMENTS = "Acme/Acme-variant.entitlements";');
    expect(after).not.toContain('ios/Acme');
  });

  it('leaves everything else in the file untouched', () => {
    const boundary = boundaryWithProject();
    applySwap(boundary, projectOf(swappableConfig), 'Debug');
    const after = boundary.fs.read(PBXPROJ_PATH);
    expect(after).toContain('isa = PBXFileReference');
    expect(after).not.toContain(codeSignLine(APP_SHIPPING));
  });

  it('fails when the project spells no matching assignment', () => {
    const boundary = boundaryWithProject(pbxproj('other.entitlements', 'other.entitlements'));
    expect(() => applySwap(boundary, projectOf(swappableConfig), 'Debug')).toThrow(
      /matched no CODE_SIGN_ENTITLEMENTS in the project file/,
    );
  });

  it('refuses to build when a target asks for a swap it cannot have', () => {
    // The dangerous case: dropping it quietly would build with FULL entitlements
    // and sign against a variant profile that does not carry them.
    const boundary = boundaryWithProject(pbxprojWith({ Acme: APP_SHIPPING }));
    expect(() => applySwap(boundary, projectOf(swappableConfig), 'Debug')).toThrow(
      /Upload Widget declare variantEntitlements, but .* assigns them no CODE_SIGN_ENTITLEMENTS/,
    );
    expect(boundary.writes).toEqual([]);
  });

  it('names the assignments it looked for when nothing matched', () => {
    const boundary = boundaryWithProject(pbxproj('other.entitlements', 'other.entitlements'));
    expect(() => applySwap(boundary, projectOf(swappableConfig), 'Debug')).toThrow(
      /Nothing in .* assigns one of: other\.entitlements, other\.entitlements/,
    );
  });

  it('does not write the file when the swap failed', () => {
    const boundary = boundaryWithProject(pbxproj('other.entitlements', 'other.entitlements'));
    expect(() => applySwap(boundary, projectOf(swappableConfig), 'Debug')).toThrow();
    expect(boundary.writes).toEqual([]);
  });
});

describe('findStrandedSwap', () => {
  it('detects a live variant assignment left by an interrupted run', () => {
    const boundary = boundaryWithProject(SWAPPED);
    expect(findStrandedSwap(boundary, projectOf(swappableConfig), 'Debug')).toBe(PBXPROJ_PATH);
  });

  it('detects a partial strand — one target swapped, one not', () => {
    const boundary = boundaryWithProject(pbxproj(APP_VARIANT, WIDGET_SHIPPING));
    expect(findStrandedSwap(boundary, projectOf(swappableConfig), 'Debug')).toBe(PBXPROJ_PATH);
  });

  it('does not flag a clean project that merely references the variant file', () => {
    // The variant entitlements file exists on disk, so a clean project file
    // names it in its file references. Only an assignment counts.
    expect(CLEAN).toContain('Acme-variant.entitlements');
    const boundary = boundaryWithProject(CLEAN);
    expect(findStrandedSwap(boundary, projectOf(swappableConfig), 'Debug')).toBeNull();
  });

  it('returns null when there is no project file to read', () => {
    expect(findStrandedSwap(fakeBoundary(), projectOf(swappableConfig), 'Debug')).toBeNull();
  });
});

describe('withEntitlementSwap', () => {
  const options = {
    suffix: 'wave',
    backupPath: '/scratch/project.pbxproj.orig',
    configuration: 'Debug',
  };

  it('is a no-op without a variant slug', async () => {
    const boundary = boundaryWithProject();
    const result = await withEntitlementSwap(
      boundary,
      projectOf(swappableConfig),
      { ...options, suffix: '' },
      async () => {
        expect(boundary.fs.read(PBXPROJ_PATH)).toBe(CLEAN);
        return 'body ran';
      },
    );
    expect(result).toBe('body ran');
    expect(boundary.writes).toEqual([]);
  });

  it('is a no-op when no target declares both files', async () => {
    const boundary = boundaryWithProject();
    await withEntitlementSwap(boundary, projectOf(), options, async () => 'body ran');
    expect(boundary.writes).toEqual([]);
  });

  it('patches the file for the body and restores it byte-identically', async () => {
    const boundary = boundaryWithProject();
    let seen = '';
    const result = await withEntitlementSwap(
      boundary,
      projectOf(swappableConfig),
      options,
      async () => {
        seen = boundary.fs.read(PBXPROJ_PATH);
        return 'app path';
      },
    );
    expect(seen).toBe(SWAPPED);
    expect(result).toBe('app path');
    expect(boundary.fs.read(PBXPROJ_PATH)).toBe(CLEAN);
  });

  it('backs the original up before patching', async () => {
    const boundary = boundaryWithProject();
    await withEntitlementSwap(boundary, projectOf(swappableConfig), options, async () => {
      expect(boundary.fs.read(options.backupPath)).toBe(CLEAN);
      return 0;
    });
  });

  it('restores byte-identically when the body throws, and rethrows', async () => {
    const boundary = boundaryWithProject();
    await expect(
      withEntitlementSwap(boundary, projectOf(swappableConfig), options, async () => {
        throw new Error('the build failed');
      }),
    ).rejects.toThrow('the build failed');
    expect(boundary.fs.read(PBXPROJ_PATH)).toBe(CLEAN);
  });

  it('refuses to run over a swap stranded by an earlier run', async () => {
    const boundary = boundaryWithProject(SWAPPED);
    let ran = false;
    await expect(
      withEntitlementSwap(boundary, projectOf(swappableConfig), options, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/still carries a variant entitlement swap from an interrupted run/);
    expect(ran).toBe(false);
    expect(boundary.fs.read(PBXPROJ_PATH)).toBe(SWAPPED);
  });

  it('names the git command that undoes a stranded swap', async () => {
    const boundary = boundaryWithProject(SWAPPED);
    await expect(
      withEntitlementSwap(boundary, projectOf(swappableConfig), options, async () => 0),
    ).rejects.toThrow(new RegExp(`git checkout -- ${PBXPROJ_PATH}`));
  });

  it('removes its signal listeners afterwards', async () => {
    const boundary = boundaryWithProject();
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
    };
    let during = 0;
    await withEntitlementSwap(boundary, projectOf(swappableConfig), options, async () => {
      during = process.listenerCount('SIGINT');
    });
    expect(during).toBe(before.SIGINT + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP);
  });

  it('removes its signal listeners even when the body throws', async () => {
    const boundary = boundaryWithProject();
    const before = process.listenerCount('SIGINT');
    await expect(
      withEntitlementSwap(boundary, projectOf(swappableConfig), options, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('adds no listeners at all on the no-op path', async () => {
    const boundary = boundaryWithProject();
    let during = 0;
    await withEntitlementSwap(
      boundary,
      projectOf(swappableConfig),
      { ...options, suffix: '' },
      async () => {
        during = process.listenerCount('SIGINT');
      },
    );
    expect(during).toBe(process.listenerCount('SIGINT'));
  });
});
