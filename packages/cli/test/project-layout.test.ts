/**
 * Both of these were config fields that restated a directory listing. What is
 * left is the one question a listing cannot answer — which of several projects
 * to build — so that is the only case that asks anybody anything.
 */
import { describe, expect, it } from 'vitest';
import { projectSpecName, resolveXcodeproj, xcodeprojNames } from '../src/project-layout.js';
import { fakeBoundary } from './helpers/fake-boundary.js';

const withFiles = (...paths: string[]) =>
  fakeBoundary({ files: Object.fromEntries(paths.map((path) => [path, 'x'])) });

describe('resolveXcodeproj', () => {
  it('infers the one project in the directory', () => {
    const boundary = withFiles('/w/ios/Acme.xcodeproj/project.pbxproj');
    expect(resolveXcodeproj(boundary, '/w/ios', {})).toBe('Acme.xcodeproj');
  });

  it('keeps an explicit name, which is how several are settled', () => {
    const boundary = withFiles(
      '/w/ios/Acme.xcodeproj/project.pbxproj',
      '/w/ios/Legacy.xcodeproj/project.pbxproj',
    );
    expect(resolveXcodeproj(boundary, '/w/ios', { xcodeproj: 'Legacy.xcodeproj' })).toBe(
      'Legacy.xcodeproj',
    );
  });

  it('lists what it found when several could be meant', () => {
    const boundary = withFiles(
      '/w/ios/Acme.xcodeproj/project.pbxproj',
      '/w/ios/Legacy.xcodeproj/project.pbxproj',
    );
    expect(() => resolveXcodeproj(boundary, '/w/ios', {})).toThrow(
      /more than one \.xcodeproj[\s\S]*Acme\.xcodeproj[\s\S]*Legacy\.xcodeproj/,
    );
  });

  it('says where it looked when there is none', () => {
    expect(() => resolveXcodeproj(withFiles(), '/w/ios', {})).toThrow(
      /no \.xcodeproj was found in \/w\/ios/,
    );
  });

  /** A workspace build never opens a `.xcodeproj`, so nothing is missing. */
  it('is quiet with no project when a workspace is configured', () => {
    const boundary = withFiles('/w/ios/Acme.xcworkspace/contents.xcworkspacedata');
    expect(
      resolveXcodeproj(boundary, '/w/ios', { xcworkspace: 'Acme.xcworkspace' }),
    ).toBeUndefined();
  });

  /**
   * A workspace usually sits beside the project it wraps, and the pbxproj is
   * still worth reading — the bundle ids and entitlements are in it.
   */
  it('still infers the project beside a workspace', () => {
    const boundary = withFiles(
      '/w/ios/Acme.xcworkspace/contents.xcworkspacedata',
      '/w/ios/Acme.xcodeproj/project.pbxproj',
    );
    expect(resolveXcodeproj(boundary, '/w/ios', { xcworkspace: 'Acme.xcworkspace' })).toBe(
      'Acme.xcodeproj',
    );
  });
});

describe('xcodeprojNames', () => {
  it('is empty for a directory that does not exist', () => {
    expect(xcodeprojNames(fakeBoundary(), '/nowhere')).toEqual([]);
  });
});

describe('projectSpecName', () => {
  it('finds project.yml beside the project', () => {
    expect(projectSpecName(withFiles('/w/ios/project.yml'), '/w/ios')).toBe('project.yml');
  });

  it('finds the .yaml spelling too', () => {
    expect(projectSpecName(withFiles('/w/ios/project.yaml'), '/w/ios')).toBe('project.yaml');
  });

  it('prefers project.yml, which is what XcodeGen reads first', () => {
    const boundary = withFiles('/w/ios/project.yaml', '/w/ios/project.yml');
    expect(projectSpecName(boundary, '/w/ios')).toBe('project.yml');
  });

  it('is nothing when the project is not generated', () => {
    expect(
      projectSpecName(withFiles('/w/ios/Acme.xcodeproj/project.pbxproj'), '/w/ios'),
    ).toBeUndefined();
  });
});
