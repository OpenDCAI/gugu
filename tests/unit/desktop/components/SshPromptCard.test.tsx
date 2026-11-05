// @vitest-environment jsdom
// #6264 ssh 提问卡片:直连终端上方用的是添加机器同一张卡片,另带一颗「取消」;指纹变了是拒绝(说原因 + 删旧记录的命令)。
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SshHostKeyChanged } from '../../../../apps/desktop/src/components/settings/addServer/SshHostKeyChanged'
import { SshPromptCard } from '../../../../apps/desktop/src/components/settings/addServer/SshPromptCard'
import { createReactHarness } from '../../../support/testHarness'

const password = { id: 'p1', kind: 'password' as const, message: "alice@box's password: ", subject: 'alice@box' }
const buttons = () => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())

describe('SshPromptCard', () => {
  it('cancellable:多一颗「取消」,点了 = 回答 null;不带时(添加机器)没有这颗', async () => {
    const onAnswer = vi.fn()
    const harness = createReactHarness()
    await harness.render(<SshPromptCard prompt={password} onAnswer={onAnswer} cancellable />)
    expect(buttons()).toContain('取消')
    await act(async () => {
      (document.querySelector('[data-testid="ssh-prompt-cancel"]') as HTMLButtonElement).click()
    })
    expect(onAnswer).toHaveBeenCalledWith(null)
    await harness.render(<SshPromptCard prompt={password} onAnswer={onAnswer} />)
    expect(document.querySelector('[data-testid="ssh-prompt-cancel"]')).toBeNull()
    harness.cleanup()
  })
})

describe('SshPromptCard「下次免密」', () => {
  const box = () => document.querySelector<HTMLInputElement>('[data-testid="ssh-prompt-install-key"]')
  const submit = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="add-server-secret"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.form!.requestSubmit()
    })
  }

  it('登录密码且能装钥匙时才有那个勾,默认不勾;不勾提交 = 只给密码', async () => {
    const onAnswer = vi.fn()
    const harness = createReactHarness()
    await harness.render(<SshPromptCard prompt={{ ...password, offerKeyInstall: true }} onAnswer={onAnswer} />)
    expect(box()).not.toBeNull()
    expect(box()!.checked).toBe(false)
    expect(document.body.textContent).toContain('下次免密')
    await submit('pw')
    expect(onAnswer).toHaveBeenCalledWith('pw', { installKey: false })
    await harness.render(<SshPromptCard prompt={password} onAnswer={onAnswer} />)
    expect(box()).toBeNull()
    await harness.render(
      <SshPromptCard prompt={{ id: 'k1', kind: 'passphrase', message: 'x', subject: '~/.ssh/id', offerKeyInstall: true }} onAnswer={onAnswer} />,
    )
    expect(box()).toBeNull()
    harness.cleanup()
  })

  it('勾上再提交 = 带 installKey;密码不对再问一遍(新 id)时勾还在', async () => {
    const onAnswer = vi.fn()
    const harness = createReactHarness()
    await harness.render(<SshPromptCard prompt={{ ...password, offerKeyInstall: true }} onAnswer={onAnswer} variant="floating" cancellable />)
    await act(async () => {
      box()!.click()
    })
    await submit('wrong')
    expect(onAnswer).toHaveBeenLastCalledWith('wrong', { installKey: true })
    await harness.render(
      <SshPromptCard prompt={{ ...password, id: 'p2', retry: true, offerKeyInstall: true }} onAnswer={onAnswer} variant="floating" cancellable />,
    )
    expect(box()!.checked).toBe(true)
    await submit('right')
    expect(onAnswer).toHaveBeenLastCalledWith('right', { installKey: true })
    harness.cleanup()
  })
})

describe('SshHostKeyChanged', () => {
  it('说清为什么停、新指纹、删旧记录的命令 —— 没有「信任」按钮', async () => {
    const harness = createReactHarness()
    await harness.render(<SshHostKeyChanged hostKey={{ host: '[box]:2222', fingerprint: 'SHA256:new' }} explain />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('这台机器的身份变了')
    expect(text).toContain('SHA256:new')
    expect(document.querySelector('[data-testid="ssh-host-key-remove"] code')?.textContent).toBe("ssh-keygen -R '[box]:2222'")
    expect(buttons()).not.toContain('信任并继续')
    harness.cleanup()
  })
})
