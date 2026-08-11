/**
 * The entitlement swap edits a tracked file in place and puts it back. Two
 * things are load-bearing and both are asserted literally here: the exact
 * spelling of the patched line (byte-identity is what keeps the build
 * incremental), and that the original bytes always come back.
 */
import { describe, expect, it } from 'vitest';
import {
  applySwap,
  codeSignLine,
  findStrandedSwap,
  pbxprojPath,
  swappableTargets,
  withEntitlementSwap,
} from '../src/entitlements.js';
import { projectFrom, type Project } from '../src/project.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary, type FakeBoundary } from './helpers/fake-boundary.js';

const APP_SHIPPING = 'ios/Acme/Acme.entitlements';
const APP_VARIANT = 'ios/Acme/Acme-variant.entitlements';
const WIDGET_SHIPPING = 'ios/Widget/Widget.entitlements';
const WIDGET_VARIANT = 'ios/Widget/Widget-variant.entitlements';

const swappableConfig = {
  variant: {
    targets: [
      { name: 'Acme', entitlements: APP_SHIPPING, variantEntitlements: APP_VARIANT },
      {
        name: 'Upload Widget',
        bundleIdSuffix: 'uploadwidget',
        entitlements: WIDGET_SHIPPING,
        variantEntitlements: WIDGET_VARIANT,
      },
    ],
  },
};

const projectOf = (overrides: Record<string, unknown> = {}): Project =>
  projectFrom('/w/jetbridge.config.json', testConfig(overrides));

const PBXPROJ_PATH = '/w/ios/Acme.xcodeproj/project.pbxproj';

/**
 * A project file shaped like a real one: the two assignments the swap rewrites,
 * plus a file reference that merely names the variant file — which exists on
 * disk in a clean checkout and must never read as a stranded swap.
 */
const pbxproj = (assignments: string[]): string =>
  [
    '// !$*UTF8*$!',
    '{',
    '\tobjects = {',
    '\t\tAA01 = {isa = PBXFileReference; path = "Acme-variant.entitlements"; ' +
      'sourceTree = "<group>"; };',
    '\t\tBB01 = {isa = XCBuildConfiguration; buildSettings = {',
    ...assignments.map((line) => `\t\t\t${line}`),
    '\t\t}; };',
    '\t};',
    '}',
    '',
  ].join('\n');

const CLEAN = pbxproj([codeSignLine(APP_SHIPPING), codeSignLine(WIDGET_SHIPPING)]);
const SWAPPED = pbxproj([codeSignLine(APP_VARIANT), codeSignLine(WIDGET_VARIANT)]);

const boundaryWithProject = (contents = CLEAN): FakeBoundary =>
  fakeBoundary({ files: { [PBXPROJ_PATH]: contents } });

describe('codeSignLine', () => {
  it('leaves a plain path bare', () => {
    expect(codeSignLine(APP_SHIPPING)).toBe('CODE_SIGN_ENTITLEMENTS = ios/Acme/Acme.entitlements;');
  });

  it('quotes a path containing a hyphen, exactly as a generator spells it', () => {
    // Byte-identity with a regenerated project file is what keeps xcodebuild
    // from fingerprinting a change and rebuilding the world.
    expect(codeSignLine(APP_VARIANT)).toBe(
      'CODE_SIGN_ENTITLEMENTS = "ios/Acme/Acme-variant.entitlements";',
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
    expect(swappableTargets(projectOf(swappableConfig))).toEqual([
      { from: APP_SHIPPING, to: APP_VARIANT },
      { from: WIDGET_SHIPPING, to: WIDGET_VARIANT },
    ]);
  });

  it('skips a target declaring only one of the two', () => {
    const project = projectOf({
      variant: {
        targets: [
          { name: 'Acme', entitlements: APP_SHIPPING },
          {
            name: 'Upload Widget',
            bundleIdSuffix: 'uploadwidget',
            variantEntitlements: WIDGET_VARIANT,
          },
        ],
      },
    });
    expect(swappableTargets(project)).toEqual([]);
  });

  it('is empty for a project with no targets at all', () => {
    expect(swappableTargets(projectOf())).toEqual([]);
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
    applySwap(boundary, projectOf(swappableConfig));
    expect(boundary.fs.read(PBXPROJ_PATH)).toBe(SWAPPED);
  });

  it('leaves everything else in the file untouched', () => {
    const boundary = boundaryWithProject();
    applySwap(boundary, projectOf(swappableConfig));
    const after = boundary.fs.read(PBXPROJ_PATH);
    expect(after).toContain('isa = PBXFileReference');
    expect(after).not.toContain(codeSignLine(APP_SHIPPING));
  });

  it('fails when the project spells no matching assignment', () => {
    const boundary = boundaryWithProject(pbxproj(['CODE_SIGN_ENTITLEMENTS = other.entitlements;']));
    expect(() => applySwap(boundary, projectOf(swappableConfig))).toThrow(
      /matched no CODE_SIGN_ENTITLEMENTS in the project file/,
    );
  });

  it('fails when only some of the declared pairs matched', () => {
    const boundary = boundaryWithProject(pbxproj([codeSignLine(APP_SHIPPING)]));
    expect(() => applySwap(boundary, projectOf(swappableConfig))).toThrow(
      /variant\.targets\[\]\.entitlements matches the path the project spells/,
    );
  });

  it('does not write the file when the swap failed', () => {
    const boundary = boundaryWithProject(pbxproj(['CODE_SIGN_ENTITLEMENTS = other.entitlements;']));
    expect(() => applySwap(boundary, projectOf(swappableConfig))).toThrow();
    expect(boundary.writes).toEqual([]);
  });
});

describe('findStrandedSwap', () => {
  it('detects a live variant assignment left by an interrupted run', () => {
    const boundary = boundaryWithProject(SWAPPED);
    expect(findStrandedSwap(boundary, projectOf(swappableConfig))).toBe(PBXPROJ_PATH);
  });

  it('detects a partial strand — one target swapped, one not', () => {
    const boundary = boundaryWithProject(
      pbxproj([codeSignLine(APP_VARIANT), codeSignLine(WIDGET_SHIPPING)]),
    );
    expect(findStrandedSwap(boundary, projectOf(swappableConfig))).toBe(PBXPROJ_PATH);
  });

  it('does not flag a clean project that merely references the variant file', () => {
    // The variant entitlements file exists on disk, so a clean project file
    // names it in its file references. Only an assignment counts.
    expect(CLEAN).toContain('Acme-variant.entitlements');
    const boundary = boundaryWithProject(CLEAN);
    expect(findStrandedSwap(boundary, projectOf(swappableConfig))).toBeNull();
  });

  it('returns null when there is no project file to read', () => {
    expect(findStrandedSwap(fakeBoundary(), projectOf(swappableConfig))).toBeNull();
  });
});

describe('withEntitlementSwap', () => {
  const options = { suffix: 'wave', backupPath: '/scratch/project.pbxproj.orig' };

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
