/**
 * The bundle-id segment used to be written into the config beside the target
 * name, where it drifted from the project in silence. Every case here is one
 * that drift produced: a segment that no longer matches, a target that is not
 * an extension of the app at all, and a project the tool cannot read — which
 * must be refused rather than treated as "no extensions".
 */
import { describe, expect, it } from 'vitest';
import { resolveTargets } from '../src/bundle-ids.js';
import { JetbridgeError, projectFrom } from '../src/project.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { PBXPROJ, PBXPROJ_PATH, PROJECT_FILES } from './helpers/pbxproj.js';

const projectWith = (targets: Array<{ name: string }>) =>
  projectFrom(
    '/w/jetbridge.config.json',
    testConfig({ variant: { displayName: 'Acme Dev', targets } }),
  );

const APP_AND_WIDGET = projectWith([{ name: 'Acme' }, { name: 'Upload Widget' }]);

/** The fixture with both targets' bundle ids rewritten, one configuration deep. */
const pbxprojWith = (appId: string, widgetId: string): Record<string, string> => ({
  [`/w/${PBXPROJ_PATH}`]: PBXPROJ.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev;',
    `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
  ).replace(
    'PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev.uploadwidget;',
    `PRODUCT_BUNDLE_IDENTIFIER = ${widgetId};`,
  ),
});

describe('resolveTargets', () => {
  it('derives an extension segment from the id the project gives it', () => {
    const resolved = resolveTargets(fakeBoundary({ files: PROJECT_FILES }), APP_AND_WIDGET);
    expect(resolved).toEqual([
      { name: 'Acme' },
      { name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' },
    ]);
  });

  it('gives the app itself no segment — it owns the base id', () => {
    const resolved = resolveTargets(fakeBoundary({ files: PROJECT_FILES }), APP_AND_WIDGET);
    expect(resolved[0]!.bundleIdSuffix).toBeUndefined();
  });

  it('takes a multi-segment remainder as it is spelled', () => {
    const boundary = fakeBoundary({
      files: pbxprojWith('io.acme.app.dev', 'io.acme.app.dev.share.widget'),
    });
    expect(resolveTargets(boundary, APP_AND_WIDGET)[1]!.bundleIdSuffix).toBe('share.widget');
  });

  it('reads nothing at all for a single target, which IS the app', () => {
    const boundary = fakeBoundary();
    expect(resolveTargets(boundary, projectWith([{ name: 'Acme' }]))).toEqual([{ name: 'Acme' }]);
    expect(boundary.calls).toEqual([]);
  });

  /**
   * The opposite of `xcodeproject.ts`, which degrades to no facts so a build is
   * never refused: here, treating an unreadable project as "no extensions"
   * would register the extension under the app's own id.
   */
  it('refuses to guess when the project cannot be read at all', () => {
    expect(() => resolveTargets(fakeBoundary(), APP_AND_WIDGET)).toThrow(
      /could not read the Xcode project/,
    );
  });

  it('names both ids when a target is not inside the app', () => {
    const boundary = fakeBoundary({ files: pbxprojWith('io.acme.app.dev', 'io.other.widget') });
    expect(() => resolveTargets(boundary, APP_AND_WIDGET)).toThrow(JetbridgeError);
    expect(() => resolveTargets(boundary, APP_AND_WIDGET)).toThrow(
      /Acme: io\.acme\.app\.dev[\s\S]*Upload Widget: io\.other\.widget/,
    );
  });

  it('says so when no target owns the id the others extend', () => {
    const boundary = fakeBoundary({ files: pbxprojWith('io.acme.one', 'io.acme.two') });
    expect(() => resolveTargets(boundary, APP_AND_WIDGET)).toThrow(
      /no target owns the bundle id the others extend[\s\S]*io\.acme\.one[\s\S]*io\.acme\.two/,
    );
  });

  it('refuses two targets that claim the same bundle id', () => {
    const boundary = fakeBoundary({ files: pbxprojWith('io.acme.app.dev', 'io.acme.app.dev') });
    expect(() => resolveTargets(boundary, APP_AND_WIDGET)).toThrow(/two targets share a bundle id/);
  });

  it('names a configured target the project does not define', () => {
    const boundary = fakeBoundary({ files: PROJECT_FILES });
    expect(() =>
      resolveTargets(boundary, projectWith([{ name: 'Acme' }, { name: 'Gone' }])),
    ).toThrow(/no target named "Gone"[\s\S]*It defines: Acme, Upload Widget/);
  });
});
