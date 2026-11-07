import { expect, it } from 'vitest'
import {
  enUSCapabilityMessages,
  zhCNCapabilityMessages
} from '@renderer/localization/messages-capabilities'
import { getAgentInstallErrorPresentation, type Translate } from './agent-install'
import { installFailureSummary } from './install-failure-summary'

function translate(messages = enUSCapabilityMessages): Translate {
  return (key, params) =>
    Object.entries(params ?? {}).reduce<string>(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      messages[key as keyof typeof messages] ?? key
    )
}
it.each([
  [
    'ECONNRESET connecting to https://download.example.test/file',
    'The download connection was interrupted.'
  ],
  ['tcp connect error: connection refused', 'The download connection was interrupted.'],
  ["EACCES mkdir '/Users/private/install'", 'Cannot write to the installation directory.'],
  [
    "EPERM: operation not permitted, open '/Users/private/install'",
    'Cannot write to the installation directory.'
  ],
  ["ENOSPC: no space left on device '/Users/private/install'", 'There is not enough disk space.'],
  [
    "EEXIST: file already exists, mkdir '/Users/private/install'",
    'The installation location is already in use.'
  ]
])('summarizes %s without exposing paths or raw codes', (raw, message) => {
  const result = installFailureSummary({ message: 'Command failed', diagnostic: raw }, translate())
  expect(result.message).toContain(message)
  expect(result.message).not.toContain('/Users/')
  expect(result.message).not.toMatch(/E(?:CONN|ACCES|PERM|NOSPC|EXIST)/)
  expect(result.diagnostic).toContain(raw)
})
it('uses a generic sentence for an unknown error and preserves the entire original detail', () => {
  const raw = 'unexpected installer output at /Users/private/new-version'
  const result = installFailureSummary({ message: raw, diagnostic: null }, translate())
  expect(result.message).toBe('Installation did not finish.')
  expect(result.diagnostic).toBe(raw)
})
it('localizes the cause and keeps the original diagnostic folded by the caller', () => {
  const messages = zhCNCapabilityMessages as unknown as typeof enUSCapabilityMessages
  const result = installFailureSummary(
    { message: 'Error: ECONNRESET', diagnostic: 'raw stack' },
    translate(messages)
  )
  expect(result.message).toBe('下载连接中断，未完成安装')
  expect(result.diagnostic).toContain('Error: ECONNRESET')
  expect(result.diagnostic).toContain('raw stack')
})
it('keeps cancellation and update wording distinct from download failure', () => {
  const result = installFailureSummary(
    { message: 'Update cancelled', diagnostic: null },
    translate(),
    true
  )
  expect(result.message).toBe('Update cancelled.')
})

it('keeps a structured permission denial readable after localization without an OS error code', () => {
  const messages = zhCNCapabilityMessages as unknown as typeof enUSCapabilityMessages
  const t = translate(messages)
  const failure = getAgentInstallErrorPresentation(
    { type: 'permission-denied', message: 'Permission denied', output: '' },
    { translate: t }
  )
  expect(installFailureSummary(failure, t).message).toBe('没有写入安装目录的权限')
})
