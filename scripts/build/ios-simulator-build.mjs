#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Simulator-only: Xcode embeds its simulated Keychain entitlements in the Mach-O sections and
// signs locally with '-'. Do not attach device entitlements to an ad-hoc macOS code signature.
// Release/device signing remains a separate, explicitly configured distribution build.
if (process.platform !== 'darwin') throw new Error('iOS simulator builds require macOS')
if (!process.env.DEVELOPER_DIR) throw new Error('Set DEVELOPER_DIR explicitly for the selected Xcode')
if (process.argv.length > 3) throw new Error('Usage: node scripts/build/ios-simulator-build.mjs [derivedDataPath]')
const root = fileURLToPath(new URL('../..', import.meta.url))
execFileSync('/usr/bin/xcodebuild', [
  '-project', 'apps/mobile/ios/App/App.xcodeproj', '-scheme', 'App',
  '-configuration', 'Debug', '-sdk', 'iphonesimulator',
  '-destination', 'generic/platform=iOS Simulator',
  '-derivedDataPath', resolve(root, process.argv[2] ?? '.local/ios-simulator'),
  'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual',
  'DEVELOPMENT_TEAM=', 'PROVISIONING_PROFILE_SPECIFIER=', 'build',
], { cwd: root, stdio: 'inherit' })
