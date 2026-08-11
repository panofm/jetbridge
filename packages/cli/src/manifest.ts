/**
 * The two plists an over-the-air install needs, and the escaper that guards
 * every value on the way into either.
 *
 * `manifest.plist` is what Apple's itms-services installer reads; the export
 * options plist is what `xcodebuild -exportArchive` reads. Both are generated,
 * never shipped as static files — a static export plist cannot name the
 * per-target provisioning profiles a variant signs against, and the one in the
 * tool this was extracted from had drifted to say `development` under a comment
 * claiming ad hoc.
 */
import type { OtaConfig } from './config.js';

/**
 * One escaper for both markup languages. The five entities are the intersection
 * of what XML and HTML need, so a display name containing `&` can neither
 * garble a page nor make the plist unparseable — and an unparseable manifest
 * fails the install with no message on the device.
 */
export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export interface ManifestInput {
  /** MUST match the .ipa's CFBundleIdentifier, or iOS refuses the install. */
  bundleId: string;
  /** What iOS compares to decide upgrade against reinstall. */
  bundleVersion: string;
  /** Shown in the system install confirmation sheet. */
  title: string;
  /** Absolute HTTPS URL of the .ipa. Fetched by the device with no auth header. */
  ipaUrl: string;
  /** 57×57 icon shown on the installing tile. Any square PNG works. */
  displayImageUrl?: string;
  /** 512×512 icon shown while the install finishes. */
  fullSizeImageUrl?: string;
}

const PLIST_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

export function renderManifestPlist(input: ManifestInput): string {
  const x = escapeHtml;
  const imageAsset = (kind: string, url: string): string =>
    `\n                <dict>
                    <key>kind</key>
                    <string>${kind}</string>
                    <key>url</key>
                    <string>${x(url)}</string>
                </dict>`;

  const extraAssets =
    (input.displayImageUrl ? imageAsset('display-image', input.displayImageUrl) : '') +
    (input.fullSizeImageUrl ? imageAsset('full-size-image', input.fullSizeImageUrl) : '');

  return `${PLIST_HEADER}<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${x(input.ipaUrl)}</string>
                </dict>${extraAssets}
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${x(input.bundleId)}</string>
                <key>bundle-version</key>
                <string>${x(input.bundleVersion)}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${x(input.title)}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>
`;
}

/**
 * The Safari-openable link that hands off to the iOS installer. The manifest
 * URL carries `://`, `/` and `?`, so it has to be percent-encoded — unencoded,
 * Safari reads the manifest's own query string as part of the link's.
 */
export const itmsServicesUrl = (manifestUrl: string): string =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

export interface ExportOptionsInput {
  teamId: string;
  method: OtaConfig['exportMethod'];
  /**
   * Bundle id → provisioning profile name, one entry per signed target. Empty
   * for a plain build, which keeps the project's own automatic signing.
   */
  provisioningProfiles?: Record<string, string>;
}

/**
 * The `-exportOptionsPlist` argument to `xcodebuild -exportArchive`.
 *
 * `method` is written through from the config verbatim. Xcode 16 renamed
 * `ad-hoc` to `release-testing` and still accepts the old spelling with a
 * deprecation warning, so the old one is the value that works on both.
 *
 * A variant signs manually: its profiles were minted minutes ago by the
 * provisioner and automatic signing would pick whatever Xcode already had
 * cached for that bundle id instead.
 */
export function renderExportOptionsPlist(input: ExportOptionsInput): string {
  const x = escapeHtml;
  const profiles = Object.entries(input.provisioningProfiles ?? {});
  const manual = profiles.length > 0;
  const profileDict = manual
    ? `
    <key>provisioningProfiles</key>
    <dict>
${profiles
  .map(
    ([bundleId, profile]) =>
      `        <key>${x(bundleId)}</key>\n        <string>${x(profile)}</string>`,
  )
  .join('\n')}
    </dict>`
    : '';

  return `${PLIST_HEADER}<dict>
    <key>method</key>
    <string>${x(input.method)}</string>
    <key>teamID</key>
    <string>${x(input.teamId)}</string>
    <key>signingStyle</key>
    <string>${manual ? 'manual' : 'automatic'}</string>
    <key>destination</key>
    <string>export</string>
    <key>compileBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <false/>
    <key>stripSwiftSymbols</key>
    <true/>${profileDict}
</dict>
</plist>
`;
}
