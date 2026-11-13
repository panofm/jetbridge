export const APPLICATION = 'com.apple.product-type.application';

export interface SettingsTarget {
  target: string;
  product: string;
  type?: string;
}

/** `xcodebuild -showBuildSettings -json`, trimmed to the keys that matter, in Xcode's shape. */
export const settingsJson = (...targets: SettingsTarget[]): string =>
  JSON.stringify(
    targets.map(({ target, product, type = APPLICATION }) => ({
      action: 'build',
      buildSettings: {
        FULL_PRODUCT_NAME: product,
        PRODUCT_NAME: product.replace(/\.[^.]+$/, ''),
        PRODUCT_TYPE: type,
        TARGET_NAME: target,
        WRAPPER_NAME: product,
      },
      target,
    })),
    null,
    2,
  );
