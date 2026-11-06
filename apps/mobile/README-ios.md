# iOS simulator client

The iOS app uses the shared phone renderer with Capacitor 8.3.3 and a Swift Package Manager project in `ios/App`. It has no Apple account or distribution-signing configuration.

## Build and run

Install the repository's pinned dependencies, select an installed Xcode explicitly, and build against a configured non-production environment:

```sh
DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer \
  GUGU_DB_TARGET=shared-test GUGU_TIER=beta pnpm ios:build:simulator
```

The output is `.local/ios-simulator/Build/Products/Debug-iphonesimulator/App.app`. Install it on a simulator you own:

```sh
DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer \
  xcrun simctl install <simulator-udid> .local/ios-simulator/Build/Products/Debug-iphonesimulator/App.app
```

`cap:sync` continues to sync Android only; `cap:sync:ios` rebuilds the shared renderer and syncs iOS. Android's native project and plugin selection are unchanged.

## Simulator signing and device signing

`scripts/build/ios-simulator-build.mjs` fixes the SDK to `iphonesimulator`, the configuration to Debug, and the identity to `-` (Xcode's **Sign to Run Locally**). Team and provisioning-profile settings are explicitly empty. Xcode embeds simulated Keychain entitlements in the Mach-O and invokes local ad-hoc code signing. No certificate or Apple account is used. `CODE_SIGNING_ALLOWED=NO` is suitable for compilation checks, but omits the simulated identity needed by Keychain during interactive runs.

These command-line settings are not in Release or TestFlight configuration. A future device/distribution build must be configured separately by the account holder or an authorized CI operator, using the real developer team, appropriate Apple signing identity, and provisioning profile. The simulator helper cannot build an archive or target a real device.

## Native boundaries

`GuguAuthStorage` stores authentication data in the app's Keychain access group, with `WhenUnlockedThisDeviceOnly` protection and serialized operations. It supports `sb-main`, `sb-main-code-verifier`, and `sb-main-oauth-pending`; only temporary keys can be removed. Session retirement remains an explicit envelope write. Storage errors reject the operation; there is no plaintext fallback.

The iOS adapter exposes only implemented foreground capabilities. Android's local agent, phone tools, downloadable Apps, APK updates, background watch, native sharing, scanning, and notifications are unavailable. Google login remains unavailable until its callback and browser flow are implemented for iOS. File input uses the system WebView picker.

The project adopts UIKit's scene lifecycle, required by the iOS 27 SDK. The WebView is contained inside the safe area so the shared renderer's controls remain outside system bars.

## Device declaration

`TARGETED_DEVICE_FAMILY = 1` declares an iPhone app, usable in iPad compatibility mode. `UIRequiredDeviceCapabilities` is absent: there is no telephony or SMS requirement. The deployment target is iOS 15; runtime verification is reported separately from this declaration.
