/**
 * Capabilities are derived, never declared. Every case here is one the old
 * hand-written list got wrong silently: a key nobody thought to add, a key
 * Apple invented after this table was written, and — the expensive one — the
 * shipping entitlements being read where the variant's reduced file was meant,
 * which asks Apple for capabilities the public API refuses to grant.
 */
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, entitlementsPathFor } from '../src/capabilities.js';
import { JetbridgeError, projectFrom } from '../src/project.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary } from './helpers/fake-boundary.js';

const project = projectFrom('/w/jetbridge.config.json', testConfig());

/** What Xcode writes for an app with push, associated domains and app groups. */
const SHIPPING_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>development</string>
	<key>com.apple.developer.associated-domains</key>
	<array>
		<string>applinks:acme.example</string>
	</array>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>group.io.acme.app.dev</string>
	</array>
	<key>com.apple.developer.applesignin</key>
	<array>
		<string>Default</string>
	</array>
</dict>
</plist>
`;

/** The same app as a variant: what the public API cannot grant is dropped. */
const VARIANT_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>development</string>
	<key>com.apple.developer.associated-domains</key>
	<array>
		<string>applinks:acme.example</string>
	</array>
</dict>
</plist>
`;

const boundaryWith = (files: Record<string, string>) => fakeBoundary({ files });

describe('capabilitiesFor', () => {
  it('maps a realistic entitlements file to capability types', () => {
    const boundary = boundaryWith({ '/w/ios/Acme.entitlements': SHIPPING_ENTITLEMENTS });
    expect(capabilitiesFor(boundary, project, { name: 'Acme' }, 'ios/Acme.entitlements')).toEqual([
      'PUSH_NOTIFICATIONS',
      'ASSOCIATED_DOMAINS',
      'APP_GROUPS',
      'APPLE_ID_AUTH',
    ]);
  });

  it('prefers the variant file, which is the whole point', () => {
    const boundary = boundaryWith({
      '/w/ios/Acme.entitlements': SHIPPING_ENTITLEMENTS,
      '/w/ios/Acme.variant.entitlements': VARIANT_ENTITLEMENTS,
    });
    // App groups and Sign in with Apple are dropped by the variant file, and
    // asking Apple for either through the public API fails the run.
    expect(
      capabilitiesFor(
        boundary,
        project,
        { name: 'Acme', variantEntitlements: 'ios/Acme.variant.entitlements' },
        'ios/Acme.entitlements',
      ),
    ).toEqual(['PUSH_NOTIFICATIONS', 'ASSOCIATED_DOMAINS']);
  });

  it('skips an entitlement it does not recognise', () => {
    const boundary = boundaryWith({
      '/w/ios/Acme.entitlements': `<plist version="1.0"><dict>
	<key>com.apple.developer.something-apple-shipped-yesterday</key>
	<true/>
	<key>aps-environment</key>
	<string>production</string>
</dict></plist>`,
    });
    expect(capabilitiesFor(boundary, project, { name: 'Acme' }, 'ios/Acme.entitlements')).toEqual([
      'PUSH_NOTIFICATIONS',
    ]);
  });

  it('yields nothing when the target declares no entitlements file', () => {
    expect(capabilitiesFor(boundaryWith({}), project, { name: 'Acme' })).toEqual([]);
  });

  it('yields nothing when the declared file is not on disk', () => {
    expect(
      capabilitiesFor(boundaryWith({}), project, { name: 'Acme' }, 'ios/Gone.entitlements'),
    ).toEqual([]);
  });

  it('yields nothing for a file that declares no capability keys', () => {
    const boundary = boundaryWith({
      '/w/ios/Acme.entitlements': `<plist version="1.0"><dict>
	<key>com.apple.developer.team-identifier</key>
	<string>ABCDE12345</string>
</dict></plist>`,
    });
    expect(capabilitiesFor(boundary, project, { name: 'Acme' }, 'ios/Acme.entitlements')).toEqual(
      [],
    );
  });

  /**
   * A file that IS there and does not parse is a broken project, not an absent
   * one — silently provisioning no capabilities would mint a profile that
   * signs and then fails to install.
   */
  it('fails loudly on a malformed entitlements file', () => {
    const boundary = boundaryWith({ '/w/ios/Acme.entitlements': 'not a plist at all' });
    expect(() =>
      capabilitiesFor(boundary, project, { name: 'Acme' }, 'ios/Acme.entitlements'),
    ).toThrow(JetbridgeError);
  });
});

describe('entitlementsPathFor', () => {
  it('is the variant file when there is one', () => {
    expect(entitlementsPathFor({ name: 'Acme', variantEntitlements: 'b' }, 'a')).toBe('b');
  });

  it('falls back to the shipping file the project declares', () => {
    expect(entitlementsPathFor({ name: 'Acme' }, 'a')).toBe('a');
  });

  it('is undefined when there is neither', () => {
    expect(entitlementsPathFor({ name: 'Acme' })).toBeUndefined();
  });
});
