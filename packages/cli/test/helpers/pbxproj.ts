/**
 * One realistic `project.pbxproj`, shared by every suite that needs one.
 *
 * Realistic rather than minimal, because the easy project is not where this
 * breaks: three build configurations (not just Debug and Release), two targets,
 * and — the detail that matters most — `CODE_SIGN_ENTITLEMENTS` spelled the way
 * Xcode spells it, RELATIVE TO THE PROJECT DIRECTORY (`Acme/Acme.entitlements`)
 * and not to the repository root. A fixture that spells it root-relative makes
 * the entitlement swap look like it works when it matches nothing.
 */
export const PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {

/* Begin PBXNativeTarget section */
		A100000000000000000001 /* Acme */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = C100000000000000000001 /* Build configuration list for PBXNativeTarget "Acme" */;
			buildPhases = (
				B100000000000000000001 /* Sources */,
			);
			name = Acme;
			productName = Acme;
			productType = "com.apple.product-type.application";
		};
		A100000000000000000002 /* Upload Widget */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = C100000000000000000002 /* Build configuration list for PBXNativeTarget "Upload Widget" */;
			name = "Upload Widget";
			productType = "com.apple.product-type.app-extension";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		P100000000000000000001 /* Project object */ = {
			isa = PBXProject;
			attributes = {
				BuildIndependentTargetsInParallel = 1;
				LastUpgradeCheck = 1600;
			};
			buildConfigurationList = C100000000000000000000 /* Build configuration list for PBXProject "Acme" */;
			targets = (
				A100000000000000000001 /* Acme */,
				A100000000000000000002 /* Upload Widget */,
			);
		};
/* End PBXProject section */

/* Begin XCBuildConfiguration section */
		D100000000000000000000 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				DEVELOPMENT_TEAM = ABCDE12345;
				SDKROOT = iphoneos;
			};
			name = Debug;
		};
		D100000000000000000010 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				DEVELOPMENT_TEAM = ABCDE12345;
				SDKROOT = iphoneos;
			};
			name = Release;
		};
		D100000000000000000020 /* Staging */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				DEVELOPMENT_TEAM = ABCDE12345;
				SDKROOT = iphoneos;
			};
			name = Staging;
		};
		D100000000000000000001 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_ENTITLEMENTS = Acme/Acme.entitlements;
				INFOPLIST_KEY_CFBundleDisplayName = "Acme Dev";
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev;
			};
			name = Debug;
		};
		D100000000000000000011 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_ENTITLEMENTS = Acme/Acme.entitlements;
				INFOPLIST_KEY_CFBundleDisplayName = Acme;
				PRODUCT_BUNDLE_IDENTIFIER = io.acme.app;
			};
			name = Release;
		};
		D100000000000000000021 /* Staging */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.staging;
			};
			name = Staging;
		};
		D100000000000000000002 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_ENTITLEMENTS = "Upload Widget/UploadWidget.entitlements";
				PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev.uploadwidget;
			};
			name = Debug;
		};
		D100000000000000000012 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.uploadwidget;
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		C100000000000000000000 /* Build configuration list for PBXProject "Acme" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				D100000000000000000000 /* Debug */,
				D100000000000000000010 /* Release */,
				D100000000000000000020 /* Staging */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		C100000000000000000001 /* Build configuration list for PBXNativeTarget "Acme" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				D100000000000000000001 /* Debug */,
				D100000000000000000011 /* Release */,
				D100000000000000000021 /* Staging */,
			);
		};
		C100000000000000000002 /* Build configuration list for PBXNativeTarget "Upload Widget" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				D100000000000000000002 /* Debug */,
				D100000000000000000012 /* Release */,
			);
		};
/* End XCConfigurationList section */
	};
	rootObject = P100000000000000000001 /* Project object */;
}
`;

/** Where the fixture lives for a project whose `iosDir` is `ios`. */
export const PBXPROJ_PATH = 'ios/Acme.xcodeproj/project.pbxproj';

/** The app target's entitlements, as the fixture spells it. */
export const APP_ENTITLEMENTS_RAW = 'Acme/Acme.entitlements';

/** The same file, relative to the config at the repository root. */
export const APP_ENTITLEMENTS = 'ios/Acme/Acme.entitlements';

/**
 * A small but VALID project file with the given `CODE_SIGN_ENTITLEMENTS` per
 * target — two native targets, a project object, and configuration lists, so
 * `parsePbxproj` finds real targets in it.
 *
 * A fragment would not do. `parsePbxproj` returns no targets for one, so
 * anything deriving from the project silently sees nothing to do and the test
 * passes while the real run does nothing at all.
 *
 * Each value is spelled the way Xcode spells it: relative to the project
 * directory, not the repository root.
 */
export function pbxprojWith(entitlements: Record<string, string | undefined>): string {
  const targets = [
    { id: 'A001', list: 'C001', config: 'D001', name: 'Acme' },
    { id: 'A002', list: 'C002', config: 'D002', name: 'Upload Widget' },
  ];
  const setting = (name: string): string => {
    const value = entitlements[name];
    if (!value) return '';
    // Quoted exactly as a generator would — the swap matches on these bytes.
    return `\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${
      /[^A-Za-z0-9/._]/.test(value) ? `"${value}"` : value
    };`;
  };
  return `// !$*UTF8*$!
{
	objects = {
		F001 = {isa = PBXFileReference; path = "Acme-variant.entitlements"; sourceTree = "<group>"; };
${targets
  .map(
    (target) => `		${target.id} = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${target.list};
			name = "${target.name}";
			productType = "com.apple.product-type.application";
		};
		${target.config} = {
			isa = XCBuildConfiguration;
			buildSettings = {${setting(target.name)}
			};
			name = Debug;
		};
		${target.list} = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${target.config},
			);
		};`,
  )
  .join('\n')}
		P001 = {
			isa = PBXProject;
			buildConfigurationList = C000;
			targets = (
${targets.map((target) => `				${target.id},`).join('\n')}
			);
		};
		D000 = {isa = XCBuildConfiguration; buildSettings = { }; name = Debug; };
		C000 = {isa = XCConfigurationList; buildConfigurations = ( D000, ); };
	};
	rootObject = P001;
}
`;
}

/**
 * Seeded into a fake boundary's filesystem by every suite that builds a project
 * rooted at `/w` — the bundle ids and entitlements are read from this file now,
 * so a boundary without it is a project that cannot be read.
 */
export const PROJECT_FILES: Record<string, string> = { [`/w/${PBXPROJ_PATH}`]: PBXPROJ };
