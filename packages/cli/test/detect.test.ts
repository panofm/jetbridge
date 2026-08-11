/**
 * Detection is what decides how many questions the wizard has to ask, so the
 * fixture below is a realistic pbxproj rather than a minimal one: three build
 * configurations (a project with only Debug and Release is the easy case), two
 * targets, an entitlements file, and a team id that lives at project level
 * instead of on the target.
 */
import { describe, expect, it } from 'vitest';
import {
  bundleIdSuffixFrom,
  detectProject,
  findProjectDirectory,
  parsePbxproj,
  settingValue,
} from '../src/detect.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { PBXPROJ } from './helpers/pbxproj.js';

const pbxproj = PBXPROJ;

const projectFiles = (dir = 'ios'): Record<string, string> => ({
  [`/repo/${dir}/Acme.xcodeproj/project.pbxproj`]: pbxproj,
  [`/repo/${dir}/Acme.xcodeproj/xcshareddata/xcschemes/Acme.xcscheme`]: '<Scheme/>',
  [`/repo/${dir}/Acme/Acme.entitlements`]: '<plist/>',
});

const boundaryWith = (files: Record<string, string>) => fakeBoundary({ cwd: '/repo', files });

describe('parsePbxproj', () => {
  it('reads the project-level build configuration list', () => {
    expect(parsePbxproj(pbxproj).projectConfigurations).toEqual(['Debug', 'Release', 'Staging']);
  });

  it('reads every target with its name and product type', () => {
    const facts = parsePbxproj(pbxproj);
    expect(facts.targets.map((t) => t.name)).toEqual(['Acme', 'Upload Widget']);
    expect(facts.targets[0]!.productType).toBe('com.apple.product-type.application');
  });

  it("keeps a target's settings separate per build configuration", () => {
    const app = parsePbxproj(pbxproj).targets[0]!;
    expect(app.settings.Debug!.PRODUCT_BUNDLE_IDENTIFIER).toBe('io.acme.app.dev');
    expect(app.settings.Release!.PRODUCT_BUNDLE_IDENTIFIER).toBe('io.acme.app');
    expect(app.settings.Staging!.PRODUCT_BUNDLE_IDENTIFIER).toBe('io.acme.app.staging');
  });

  it('unquotes a quoted setting', () => {
    const app = parsePbxproj(pbxproj).targets[0]!;
    expect(app.settings.Debug!.INFOPLIST_KEY_CFBundleDisplayName).toBe('Acme Dev');
  });

  it('drops list-valued settings instead of stringifying them', () => {
    const app = parsePbxproj(pbxproj).targets[0]!;
    expect(app.settings.Debug!.LD_RUNPATH_SEARCH_PATHS).toBeUndefined();
  });

  it('reads project-level build settings', () => {
    expect(parsePbxproj(pbxproj).projectSettings.Debug!.DEVELOPMENT_TEAM).toBe('ABCDE12345');
  });

  it('returns a partial result instead of throwing on a truncated file', () => {
    const facts = parsePbxproj(pbxproj.slice(0, 900));
    expect(facts.targets).toEqual([]);
    expect(facts.warnings.join(' ')).toMatch(/could not be parsed/);
  });

  it('returns a partial result on a file that is not a pbxproj at all', () => {
    const facts = parsePbxproj('{ "json": true }');
    expect(facts.projectConfigurations).toEqual([]);
    expect(facts.warnings).toHaveLength(1);
  });

  it('falls back to every configuration in the file, and says so', () => {
    // A project object whose configuration list is missing: the names can only
    // come from the targets, which is exactly when they cannot be trusted.
    const orphaned = pbxproj.replace(
      /\t\t\tbuildConfigurationList = C100000000000000000000[^;]*;\n/,
      '',
    );
    const facts = parsePbxproj(orphaned);
    expect(facts.projectConfigurations.sort()).toEqual(['Debug', 'Release', 'Staging']);
    expect(facts.warnings.join(' ')).toMatch(/come from every target/);
  });
});

describe('settingValue', () => {
  const settings = { Debug: { KEY: 'debug' }, Release: { KEY: 'release' } };

  it('prefers the configuration the build will name', () => {
    expect(settingValue(settings, 'KEY', ['Debug'])!.value).toBe('debug');
    expect(settingValue(settings, 'KEY', ['Release'])!.value).toBe('release');
  });

  it('reports a disagreement rather than picking a winner quietly', () => {
    expect(settingValue(settings, 'KEY', ['Debug'])!.differs).toBe(true);
    expect(settingValue({ Debug: { KEY: 'same' } }, 'KEY', ['Debug'])!.differs).toBe(false);
  });

  it('is undefined when nothing sets the key', () => {
    expect(settingValue(settings, 'MISSING', ['Debug'])).toBeUndefined();
  });
});

describe('bundleIdSuffixFrom', () => {
  it('squeezes a segment down to what a bundle id accepts', () => {
    expect(bundleIdSuffixFrom('Upload-Widget')).toBe('uploadwidget');
  });

  it('is undefined when nothing usable is left', () => {
    expect(bundleIdSuffixFrom('---')).toBeUndefined();
  });
});

describe('findProjectDirectory', () => {
  it('finds a project in the root itself', () => {
    expect(findProjectDirectory(boundaryWith(projectFiles('.')), '/repo')).toBe('/repo');
  });

  it('finds a project one directory below', () => {
    expect(findProjectDirectory(boundaryWith(projectFiles()), '/repo')).toBe('/repo/ios');
  });

  it('is undefined when there is no project anywhere near', () => {
    expect(
      findProjectDirectory(boundaryWith({ '/repo/readme.md': '# acme' }), '/repo'),
    ).toBeUndefined();
  });
});

describe('detectProject', () => {
  it('suggests the project, the directory and the scheme', () => {
    const detection = detectProject(boundaryWith(projectFiles()), { root: '/repo' });
    expect(detection.iosDir.value).toBe('ios');
    expect(detection.xcodeproj?.value).toBe('Acme.xcodeproj');
    expect(detection.xcworkspace).toBeUndefined();
    expect(detection.schemes).toEqual(['Acme']);
    expect(detection.scheme?.value).toBe('Acme');
  });

  it('carries the file each suggestion came from', () => {
    const detection = detectProject(boundaryWith(projectFiles()), { root: '/repo' });
    expect(detection.teamId?.source).toBe('ios/Acme.xcodeproj/project.pbxproj');
    expect(detection.baseBundleId?.source).toBe('ios/Acme.xcodeproj/project.pbxproj');
  });

  it('prefers the workspace when both are there, and still reads the project', () => {
    const detection = detectProject(
      boundaryWith({
        ...projectFiles(),
        '/repo/ios/Acme.xcworkspace/contents.xcworkspacedata': '<Workspace/>',
        '/repo/ios/Acme.xcworkspace/xcshareddata/xcschemes/Acme Prod.xcscheme': '<Scheme/>',
      }),
      { root: '/repo' },
    );
    expect(detection.xcworkspace?.value).toBe('Acme.xcworkspace');
    expect(detection.xcodeproj?.value).toBe('Acme.xcodeproj');
    expect(detection.schemes).toEqual(['Acme', 'Acme Prod']);
    expect(detection.baseBundleId?.value).toBe('io.acme.app.dev');
  });

  it('says so when a workspace has no project beside it', () => {
    const detection = detectProject(
      boundaryWith({ '/repo/ios/Acme.xcworkspace/contents.xcworkspacedata': '<Workspace/>' }),
      { root: '/repo' },
    );
    expect(detection.xcworkspace?.value).toBe('Acme.xcworkspace');
    expect(detection.baseBundleId).toBeUndefined();
    expect(detection.warnings.join(' ')).toMatch(/no \.xcodeproj beside it/);
  });

  it('offers the XcodeGen spec when the project is generated', () => {
    const detection = detectProject(
      boundaryWith({ ...projectFiles(), '/repo/ios/project.yml': 'name: Acme' }),
      { root: '/repo' },
    );
    expect(detection.projectYml?.value).toBe('project.yml');
    expect(detection.projectYml?.source).toBe('ios/project.yml');
  });

  it('lists every build configuration, custom ones included', () => {
    const detection = detectProject(boundaryWith(projectFiles()), { root: '/repo' });
    expect(detection.configurations?.value).toEqual(['Debug', 'Release', 'Staging']);
  });

  it('takes the bundle id and label from the configuration a cabled build uses', () => {
    const detection = detectProject(boundaryWith(projectFiles()), { root: '/repo' });
    expect(detection.baseBundleId?.value).toBe('io.acme.app.dev');
    expect(detection.displayName?.value).toBe('Acme Dev');
  });

  it('warns that the bundle id is not the same in every configuration', () => {
    const detection = detectProject(boundaryWith(projectFiles()), { root: '/repo' });
    expect(detection.warnings.join(' ')).toMatch(/the bundle id differs between configurations/);
  });

  it('falls back to the project-level team id', () => {
    const detection = detectProject(boundaryWith(projectFiles()), { root: '/repo' });
    expect(detection.teamId?.value).toBe('ABCDE12345');
  });

  it('drops a team id that is not a team id', () => {
    const detection = detectProject(
      boundaryWith({
        ...projectFiles(),
        '/repo/ios/Acme.xcodeproj/project.pbxproj': pbxproj.replaceAll(
          'DEVELOPMENT_TEAM = ABCDE12345;',
          'DEVELOPMENT_TEAM = "";',
        ),
      }),
      { root: '/repo' },
    );
    expect(detection.teamId).toBeUndefined();
  });

  it('refuses to guess a bundle id built out of other build settings', () => {
    const detection = detectProject(
      boundaryWith({
        ...projectFiles(),
        '/repo/ios/Acme.xcodeproj/project.pbxproj': pbxproj.replace(
          'PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev;',
          'PRODUCT_BUNDLE_IDENTIFIER = "$(BUNDLE_PREFIX).app.dev";',
        ),
      }),
      { root: '/repo' },
    );
    expect(detection.baseBundleId).toBeUndefined();
    expect(detection.warnings.join(' ')).toMatch(/built from other build settings/);
  });

  it('collects the app and its extension, with a usable bundle-id segment', () => {
    const detection = detectProject(boundaryWith(projectFiles()), { root: '/repo' });
    expect(detection.targets).toEqual([
      {
        name: 'Acme',
        productType: 'com.apple.product-type.application',
        isApp: true,
        bundleId: 'io.acme.app.dev',
        entitlements: {
          value: 'ios/Acme/Acme.entitlements',
          source: 'ios/Acme.xcodeproj/project.pbxproj',
        },
      },
      {
        name: 'Upload Widget',
        productType: 'com.apple.product-type.app-extension',
        isApp: false,
        bundleId: 'io.acme.app.dev.uploadwidget',
        bundleIdSuffix: 'uploadwidget',
        entitlements: {
          value: 'ios/Upload Widget/UploadWidget.entitlements',
          source: 'ios/Acme.xcodeproj/project.pbxproj',
        },
      },
    ]);
  });

  it('leaves out an entitlements path that escapes the project root', () => {
    const detection = detectProject(
      boundaryWith({
        ...projectFiles(),
        '/repo/ios/Acme.xcodeproj/project.pbxproj': pbxproj.replace(
          'CODE_SIGN_ENTITLEMENTS = Acme/Acme.entitlements;',
          'CODE_SIGN_ENTITLEMENTS = "../../shared/Acme.entitlements";',
        ),
      }),
      { root: '/repo' },
    );
    expect(detection.targets[0]!.entitlements).toBeUndefined();
    expect(detection.warnings.join(' ')).toMatch(/outside the project root/);
  });

  it('survives a malformed pbxproj with the questions still askable', () => {
    const detection = detectProject(
      boundaryWith({
        ...projectFiles(),
        '/repo/ios/Acme.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{ objects = { broken',
      }),
      { root: '/repo' },
    );
    expect(detection.xcodeproj?.value).toBe('Acme.xcodeproj');
    expect(detection.targets).toEqual([]);
    expect(detection.baseBundleId).toBeUndefined();
    expect(detection.warnings.join(' ')).toMatch(/could not be parsed/);
  });

  it('says what is wrong when there is no Xcode project at all', () => {
    const detection = detectProject(boundaryWith({ '/repo/readme.md': '# acme' }), {
      root: '/repo',
    });
    expect(detection.warnings).toEqual([
      'no .xcodeproj or .xcworkspace was found here or one directory below.',
    ]);
  });

  it('reads the directory it was told to, without searching', () => {
    const detection = detectProject(boundaryWith(projectFiles('apps/mobile')), {
      root: '/repo',
      iosDir: 'apps/mobile',
    });
    expect(detection.iosDir.value).toBe('apps/mobile');
    expect(detection.xcodeproj?.value).toBe('Acme.xcodeproj');
  });
});
