#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const PLATFORM_FILES = {
  mac: [
    'gugu-{version}-arm64.dmg',
    'gugu-{version}-arm64.dmg.blockmap',
    'gugu-{version}-x64.dmg',
    'gugu-{version}-x64.dmg.blockmap',
    'gugu-mac-arm64.dmg',
    'gugu-mac-x64.dmg',
    // #7394 新标识的包读 nextmind-mac.yml;latest-mac.yml 只列 dmg,给换标识前的老包。
    'nextmind-mac.yml',
    'latest-mac.yml',
  ],
  linux: ['gugu-{version}-x86_64.AppImage', 'latest-linux.yml'],
  windows: ['gugu-{version}-x64.exe', 'gugu-{version}-x64.exe.blockmap', 'gugu-windows-x64.exe', 'latest.yml'],
  android: ['gugu-{version}-android-release.apk', 'gugu-android.apk'],
}

const defaultStatePath = () => process.env.RELEASE_CLOSURE_STATE || path.join(process.env.RUNNER_TEMP || '.', 'release-closure-state.json')

const expectedFiles = (version) => Object.fromEntries(
  Object.entries(PLATFORM_FILES).map(([platform, files]) => [platform, files.map((file) => file.replace('{version}', version))]),
)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function localManifest(directory, version) {
  const files = expectedFiles(version)
  const manifest = {}
  const missing = []
  for (const [platform, names] of Object.entries(files)) {
    manifest[platform] = {}
    for (const name of names) {
      try {
        const bytes = await readFile(path.join(directory, name))
        if (bytes.length === 0) missing.push(`${platform}/${name} (empty)`)
        else manifest[platform][name] = { size: bytes.length, sha256: sha256(bytes) }
      } catch {
        missing.push(`${platform}/${name}`)
      }
    }
  }
  if (missing.length) throw new Error(`release preflight missing or empty files: ${missing.join(', ')}`)
  return manifest
}

export async function preflight({ directory = 'release', version, statePath = defaultStatePath() }) {
  if (!version || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) throw new Error(`invalid release version: ${version || '(empty)'}`)
  const manifest = await localManifest(directory, version)
  const state = { state: 'preflight_passed', version, manifest, recordedAt: new Date().toISOString() }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  console.log(`release closure preflight passed: ${Object.values(manifest).reduce((n, files) => n + Object.keys(files).length, 0)} files`)
  return state
}

export async function markPublished({ version, statePath = defaultStatePath() }) {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  if (state.state !== 'preflight_passed' || state.version !== version) throw new Error('release publish checkpoint requires a matching preflight state')
  const next = { ...state, state: 'published', publishedAt: new Date().toISOString() }
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`)
  console.log('release closure state: published')
  return next
}

async function request(url, options = {}) {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow', ...options })
  if (!response.ok) throw new Error(`release closure readback failed: ${response.status} ${url}`)
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) <= 0) throw new Error(`release closure readback returned an empty object: ${url}`)
  return response
}

export async function verify({ version, tag = `v${version}`, baseUrl = process.env.GUGU_DOWNLOAD_BASE_URL, token = process.env.RELEASES_REPO_TOKEN, repository = process.env.GUGU_RELEASES_REPO || 'nmhjklnm/gugu-releases', statePath = defaultStatePath() }) {
  if (!baseUrl) throw new Error('GUGU_DOWNLOAD_BASE_URL is required for release closure readback')
  if (!token) throw new Error('RELEASES_REPO_TOKEN is required for release closure readback')
  const checked = []
  for (const [platform, names] of Object.entries(expectedFiles(version))) {
    for (const name of names) {
      const url = `${baseUrl.replace(/\/$/, '')}/releases/${platform}/${name.includes(version) ? version : 'latest'}/${name}`
      await request(url)
      checked.push(url)
    }
  }

  const releaseResponse = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  })
  if (!releaseResponse.ok) throw new Error(`release closure public Release readback failed: ${releaseResponse.status} ${tag}`)
  const release = await releaseResponse.json()
  const assets = new Set((release.assets || []).map((asset) => asset.name))
  if (release.draft) throw new Error(`release closure public Release is still a draft: ${tag}`)
  const requiredAssets = Object.values(expectedFiles(version)).flat()
  const missingAssets = requiredAssets.filter((name) => !assets.has(name))
  if (missingAssets.length) throw new Error(`release closure public Release is missing assets: ${missingAssets.join(', ')}`)

  const state = { state: 'verified', version, tag, ossObjects: checked.length, releaseAssets: requiredAssets.length, verifiedAt: new Date().toISOString() }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  console.log(`release closure verified: ${checked.length} OSS objects and ${requiredAssets.length} Release assets`)
  return state
}

const [action] = process.argv.slice(2)
const version = (process.env.GITHUB_REF_NAME || '').replace(/^v/, '')
try {
  if (action === 'preflight') await preflight({ version })
  else if (action === 'published') await markPublished({ version })
  else if (action === 'verify') await verify({ version, tag: process.env.GITHUB_REF_NAME || `v${version}` })
  else if (action) throw new Error(`unknown release closure action: ${action}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  await writeFile(defaultStatePath(), `${JSON.stringify({ state: 'failed', phase: action || 'unknown', version, error: message, failedAt: new Date().toISOString() }, null, 2)}\n`)
  console.error(`release closure failed during ${action || 'unknown'}: ${message}`)
  process.exitCode = 1
}
