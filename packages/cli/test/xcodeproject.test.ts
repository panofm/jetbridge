/**
 * Two facts that used to be config and are now read from the project.
 *
 * Both have an expensive failure mode in one direction only. A configuration
 * wrongly refused blocks a build that would have worked, so an unreadable
 * project must skip the check rather than fail it. An entitlements path read in
 * the wrong spelling patches nothing, so the raw project spelling is pinned
 * literally.
 */
import { describe, expect, it } from 'vitest';
import { JetbridgeError, projectFrom, type Project } from '../src/project.js';
import {
  assertConfiguration,
  projectConfigurations,
  projectFacts,
  targetEntitlements,
} from '../src/xcodeproject.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { PBXPROJ, PBXPROJ_PATH, pbxprojWith } from './helpers/pbxproj.js';

const project: Project = projectFrom(
  '/w/jetbridge.config.json',
  testConfig({
    variant: {
      targets: [{ name: 'Acme' }, { name: 'Upload Widget' }],
    },
  }),
);

const withProject = (contents = PBXPROJ) =>
  fakeBoundary({ files: { [`/w/${PBXPROJ_PATH}`]: contents } });

describe('projectConfigurations', () => {
  it('reads the project-level list, not every name in the file', () => {
    expect(projectConfigurations(withProject(), project)).toEqual(['Debug', 'Release', 'Staging']);
  });

  it('is null when there is no project file at all', () => {
    expect(projectConfigurations(fakeBoundary(), project)).toBeNull();
  });

  it('is null when the file is not a property list', () => {
    expect(projectConfigurations(withProject('nonsense'), project)).toBeNull();
  });
});

describe('assertConfiguration', () => {
  it('accepts one the project defines', () => {
    expect(() => assertConfiguration(withProject(), project, 'Staging')).not.toThrow();
  });

  it('refuses one it does not, naming the real list', () => {
    expect(() => assertConfiguration(withProject(), project, 'Beta')).toThrow(
      /"Beta" is not one of this project's build configurations \(Debug, Release, Staging\)/,
    );
  });

  it('skips the check entirely when the project cannot be read', () => {
    // A false rejection blocks a build that would have worked. Let xcodebuild
    // be the judge instead — it is the one that actually knows.
    expect(() => assertConfiguration(fakeBoundary(), project, 'Beta')).not.toThrow();
    expect(() => assertConfiguration(withProject('nonsense'), project, 'Beta')).not.toThrow();
  });

  it('throws a JetbridgeError, so it prints as one line and not a stack', () => {
    expect(() => assertConfiguration(withProject(), project, 'Beta')).toThrow(JetbridgeError);
  });
});

describe('targetEntitlements', () => {
  it('keeps the project spelling AND the root-relative one', () => {
    // The swap matches on `raw` byte-for-byte; anything opening the file needs
    // `rootRelative`. Normalising to one loses the other.
    expect(targetEntitlements(withProject(), project, 'Debug')).toEqual({
      Acme: { raw: 'Acme/Acme.entitlements', rootRelative: 'ios/Acme/Acme.entitlements' },
      'Upload Widget': {
        raw: 'Upload Widget/UploadWidget.entitlements',
        rootRelative: 'ios/Upload Widget/UploadWidget.entitlements',
      },
    });
  });

  it('reads the configuration asked for', () => {
    // The fixture's widget declares entitlements on Debug only, and Staging
    // falls back to it rather than inventing one.
    expect(targetEntitlements(withProject(), project, 'Release').Acme?.raw).toBe(
      'Acme/Acme.entitlements',
    );
  });

  it('leaves out a target the project declares none for', () => {
    const boundary = fakeBoundary({
      files: { [`/w/${PBXPROJ_PATH}`]: pbxprojWith({ Acme: 'Acme/Acme.entitlements' }) },
    });
    const found = targetEntitlements(boundary, project, 'Debug');
    expect(Object.keys(found)).toEqual(['Acme']);
  });

  it('leaves out a path only xcodebuild could resolve', () => {
    const boundary = fakeBoundary({
      files: {
        [`/w/${PBXPROJ_PATH}`]: pbxprojWith({ Acme: '$(SRCROOT)/Acme/Acme.entitlements' }),
      },
    });
    expect(targetEntitlements(boundary, project, 'Debug')).toEqual({});
  });

  it('names only the targets the config selected', () => {
    const appOnly = projectFrom(
      '/w/jetbridge.config.json',
      testConfig({ variant: { targets: [{ name: 'Acme' }] } }),
    );
    expect(Object.keys(targetEntitlements(withProject(), appOnly, 'Debug'))).toEqual(['Acme']);
  });

  it('is empty when the project cannot be read', () => {
    expect(targetEntitlements(fakeBoundary(), project, 'Debug')).toEqual({});
  });
});

describe('projectFacts', () => {
  it('is null for a file with nothing in it, so callers cannot mistake it for empty', () => {
    expect(projectFacts(withProject('nonsense'), project)).toBeNull();
  });

  it('parses the real thing', () => {
    expect(projectFacts(withProject(), project)?.targets.map((t) => t.name)).toEqual([
      'Acme',
      'Upload Widget',
    ]);
  });
});
