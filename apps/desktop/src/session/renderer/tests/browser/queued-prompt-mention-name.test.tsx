/**
 * 排队中的那条提示,@ 提及要显示成**名字**,不是它的地址。
 *
 * 排队条打印的是「将要发出去的原文」,而 @ 提及在原文里就是 `@user:<uuid>` —— 那是发给 agent 的
 * 地址(`session_message` 认的三种之一)。输入框里和聊天记录里它都是一枚写着名字的 pill,唯独这里
 * 把 36 位 uuid 摆到了用户脸上(owner 2026-09-16 实撞,截图里那一行)。
 *
 * 两条反向对照是重点:名册里**查不到**的 token 必须原样留着(❌ 不许把不认识的字猜成某个人);
 * 点进去编辑时看到的必须仍是**原文**(那才是真要发出去的东西,❌ 不能拿显示形态骗人)。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { QueuedPromptsBand } from '@gugu/session-ui/react/components'
import {
  clearLocalSessionMentions,
  registerLocalSessionMentions,
} from '@renderer/lib/chat/chat-mention-provider'
import { renderMentionTokens } from '@renderer/lib/chat/render-mention-tokens'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/styles/tokens.css'
import '@renderer/index.css'

const URI = 'test://conversation-1'
const ADDRESS = 'aid:d24d4986-40c5-479a-90be-cbc66cbd35e8'
const LEGACY_ADDRESS = 'user:d24d4986-40c5-479a-90be-cbc66cbd35e8'

let editedText: string | null = null
let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  root?.unmount()
  root = null
  host?.remove()
  host = null
  editedText = null
  clearLocalSessionMentions(URI)
})

function mount(text: string) {
  registerLocalSessionMentions(URI, [
    { id: 'd24d4986-40c5-479a-90be-cbc66cbd35e8', name: 'Claude 1' },
  ])
  host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <SessionLocalizationProvider>
      <QueuedPromptsBand
        prompts={[{ id: 'q1', text, origin: 'typed' }]}
        renderPromptText={(value) => renderMentionTokens(value, URI)}
        onEdit={(_id, value) => { editedText = value }}
        onDelete={() => {}}
        onReorder={() => {}}
        onSendNow={() => {}}
      />
    </SessionLocalizationProvider>,
  )
}

test('显示成名字,Agent ID 不出现在界面上', async () => {
  mount(`@[Claude 1](${ADDRESS}) 你联系一下他`)
  await until('你联系一下他 is in the document', () => page.getByText('你联系一下他', { exact: false }).query() != null)

  const shown = host!.innerText
  expect(shown).toContain('@Claude 1')
  expect(shown).not.toContain(ADDRESS)
  expect(shown).toContain('你联系一下他')
})

test('名册里查不到的 token 原样留着 —— ❌ 不把不认识的字猜成某个人', async () => {
  mount('@user:00000000-0000-4000-8000-000000000000 谁')
  await until('谁 is in the document', () => page.getByText('谁', { exact: false }).query() != null)
  expect(host!.innerText).toContain('@user:00000000-0000-4000-8000-000000000000')
})

test('点进去编辑,看到的仍是原文', async () => {
  mount(`@[Claude 1](${ADDRESS}) 你联系一下他`)
  await until('@Claude 1 is in the document', () => page.getByText('@Claude 1', { exact: false }).query() != null)

  await userEvent.click(page.getByText('@Claude 1', { exact: false }))
  expect(editedText).toBe(`@[Claude 1](${ADDRESS}) 你联系一下他`)
})

test('改名之前发出去的老写法(裸 @user:<id>)照样显示成名字', async () => {
  mount(`@${LEGACY_ADDRESS} 你联系一下他`)
  await until('你联系一下他 is in the document', () => page.getByText('你联系一下他', { exact: false }).query() != null)
  expect(host!.innerText).toContain('@Claude 1')
  expect(host!.innerText).not.toContain(LEGACY_ADDRESS)
})
