import { describe, expect, it } from 'vitest'
import { isIpLikeLabel, resolveMachineDisplayName } from '@gugu/core/device/machineDisplayName'

const run = (answers: Record<string, string | null>) => (command: string, args: string[]) => answers[`${command} ${args.join(' ')}`] ?? null

describe('这台电脑在「设备」里叫什么(❌ 拿主机名截出 IP)', () => {
  it('IP 与 IP 截出的那一截都算「像 IP」;正常名字不算', () => {
    for (const ip of ['192.168.10.98', '192', '10.0.0', 'fe80::1']) expect(isIpLikeLabel(ip)).toBe(true)
    for (const name of ['Yang 的 MacBook Pro', 'd22', 'Linux 2', 'MAC-1', '']) expect(isIpLikeLabel(name)).toBe(false)
  })

  it('macOS:先「关于本机」里的名字,再本地主机名;主机名是 IP 时绝不用它', () => {
    expect(resolveMachineDisplayName({ platform: 'darwin', env: {}, hostname: '192.168.10.98', run: run({ 'scutil --get ComputerName': 'Yang 的 MacBook Pro' }) })).toBe('Yang 的 MacBook Pro')
    expect(resolveMachineDisplayName({ platform: 'darwin', env: {}, hostname: '192.168.10.98', run: run({ 'scutil --get LocalHostName': 'Yangs-MacBook-Pro' }) })).toBe('Yangs-MacBook-Pro')
    expect(resolveMachineDisplayName({ platform: 'darwin', env: {}, hostname: '192.168.10.98', run: run({}) })).toBe('')
    expect(resolveMachineDisplayName({ platform: 'darwin', env: {}, hostname: 'mbp.local', run: run({}) })).toBe('mbp')
  })

  it('Windows 用 COMPUTERNAME;Linux 用主机名第一段', () => {
    expect(resolveMachineDisplayName({ platform: 'win32', env: { COMPUTERNAME: 'DESKTOP-7Q' }, hostname: '10.1.2.3', run: run({}) })).toBe('DESKTOP-7Q')
    expect(resolveMachineDisplayName({ platform: 'linux', env: {}, hostname: 'box.example.com', run: run({}) })).toBe('box')
    expect(resolveMachineDisplayName({ platform: 'linux', env: {}, hostname: '172.17.0.3', run: run({}) })).toBe('')
  })
})
