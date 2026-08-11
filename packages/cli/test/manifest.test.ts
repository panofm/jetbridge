/**
 * The two generated plists are read by Apple's code, not ours: iOS refuses an
 * install from a manifest it cannot parse and says nothing useful on the
 * device. So both are asserted byte for byte, and the escaping is asserted with
 * the characters that actually break XML.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  itmsServicesUrl,
  renderExportOptionsPlist,
  renderManifestPlist,
} from '../src/manifest.js';

describe('escaping', () => {
  it('escapes the five characters that break XML and HTML', () => {
    expect(escapeHtml(`Acme & <Wave> "quoted" 'single'`)).toBe(
      'Acme &amp; &lt;Wave&gt; &quot;quoted&quot; &#39;single&#39;',
    );
  });

  it('escapes the ampersand first, so an entity is not double-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('manifest.plist', () => {
  it('renders exactly the bytes the iOS installer reads', () => {
    expect(
      renderManifestPlist({
        bundleId: 'io.acme.app.dev.wave',
        bundleVersion: '0.5.0',
        title: 'Acme Wave',
        ipaUrl: 'https://builds.example.com/builds/tok/builds/io.acme.app.dev.wave-42/app.ipa',
      }),
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>https://builds.example.com/builds/tok/builds/io.acme.app.dev.wave-42/app.ipa</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>io.acme.app.dev.wave</string>
                <key>bundle-version</key>
                <string>0.5.0</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>Acme Wave</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>
`);
  });

  it('escapes a display name that would otherwise make the plist unparseable', () => {
    const plist = renderManifestPlist({
      bundleId: 'io.acme.app.dev',
      bundleVersion: '1.0',
      title: 'Acme & <Sons>',
      ipaUrl: 'https://builds.example.com/a.ipa?x=1&y=2',
    });
    expect(plist).toContain('<string>Acme &amp; &lt;Sons&gt;</string>');
    expect(plist).toContain('<string>https://builds.example.com/a.ipa?x=1&amp;y=2</string>');
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
  });

  it('adds both icon assets when an icon URL is known', () => {
    const plist = renderManifestPlist({
      bundleId: 'io.acme.app.dev',
      bundleVersion: '1.0',
      title: 'Acme',
      ipaUrl: 'https://builds.example.com/a.ipa',
      displayImageUrl: 'https://builds.example.com/icon.png',
      fullSizeImageUrl: 'https://builds.example.com/icon.png',
    });
    expect(plist).toContain('<string>display-image</string>');
    expect(plist).toContain('<string>full-size-image</string>');
  });

  it('omits the icon assets entirely when there is no icon', () => {
    const plist = renderManifestPlist({
      bundleId: 'io.acme.app.dev',
      bundleVersion: '1.0',
      title: 'Acme',
      ipaUrl: 'https://builds.example.com/a.ipa',
    });
    expect(plist).not.toContain('display-image');
  });
});

describe('itms-services link', () => {
  it('percent-encodes the manifest URL, which carries :// and ?', () => {
    expect(itmsServicesUrl('https://builds.example.com/b/manifest.plist')).toBe(
      'itms-services://?action=download-manifest&url=https%3A%2F%2Fbuilds.example.com%2Fb%2Fmanifest.plist',
    );
  });
});

describe('exportOptions.plist', () => {
  it('signs automatically and names no profile without a variant', () => {
    expect(renderExportOptionsPlist({ teamId: 'ABCDE12345', method: 'ad-hoc' })).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>ad-hoc</string>
    <key>teamID</key>
    <string>ABCDE12345</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>destination</key>
    <string>export</string>
    <key>compileBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <false/>
    <key>stripSwiftSymbols</key>
    <true/>
</dict>
</plist>
`,
    );
  });

  it('signs manually against every profile a variant registered', () => {
    const plist = renderExportOptionsPlist({
      teamId: 'ABCDE12345',
      method: 'ad-hoc',
      provisioningProfiles: {
        'io.acme.app.dev.wave': 'Acme wave app',
        'io.acme.app.dev.wave.uploadwidget': 'Acme wave uploadwidget',
      },
    });
    expect(plist).toContain('<key>signingStyle</key>\n    <string>manual</string>');
    expect(plist).toContain(
      `    <key>provisioningProfiles</key>
    <dict>
        <key>io.acme.app.dev.wave</key>
        <string>Acme wave app</string>
        <key>io.acme.app.dev.wave.uploadwidget</key>
        <string>Acme wave uploadwidget</string>
    </dict>`,
    );
  });

  it('writes the configured export method through verbatim', () => {
    expect(renderExportOptionsPlist({ teamId: 'ABCDE12345', method: 'enterprise' })).toContain(
      '<key>method</key>\n    <string>enterprise</string>',
    );
  });
});
