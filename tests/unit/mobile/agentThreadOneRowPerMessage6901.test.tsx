// @vitest-environment jsdom
//
// #6901 手机看会话:发得急的那条消息下面冒出「‹ 2/2 ›」。根因是运行时的消息仓库里同一条消息有两份
// (乐观行一份、记录行一份),或者撤掉/换了世代的行还留在里面 —— 都是同父的兄弟。
// 判据读的是**运行时自己**的状态:时间线上每一条消息的 branchCount 都必须是 1,一条消息一行;
// 屏上画的顺序与记录 + 还在路上的那几句一致。8 种次序逐步检查,每一步都要成立。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 根包不依赖 assistant-ui;从 desktop 自己的 node_modules 取,与 AgentThread 是同一个模块实例(同一个 context)。
import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessage,
} from '../../../apps/desktop/node_modules/@assistant-ui/react'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { PendingSend } from '../../../apps/desktop/src/mobile/agent-watch/pending-sends'
import { createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: vi.fn(() => ({})),
}))

const { AgentThread } = await import('../../../apps/desktop/src/mobile/agent-watch/AgentThread')
const { emptyAgentWatchTimeline } = await import('../../../apps/desktop/src/mobile/agent-watch/agent-watch-store')

/** 运行时眼里的这条线:每条消息 `id:branchCount`。挂在 AgentThread 的 footerNotice 插槽里,在它的 runtime 之内。 */
type ThreadBranches = { thread: { messages: readonly { id: string; branchCount: number }[] } }
function BranchProbe() {
  const branches = useAuiState((s: ThreadBranches) => s.thread.messages.map((m) => `${m.id}:${m.branchCount}`).join(' '))
  return <span data-testid="branch-probe" data-branches={branches} />
}

let seq = 0
type Line = ['user' | 'assistant', string, string]
function turn(id: string, lines: Line[]): TranscriptTurn {
  seq += 1
  return {
    id, seq, initiator: 'user',
    items: lines.map(([role, itemId, text], index) => ({ kind: 'message', id: itemId, seq: index, role, text })),
  } as unknown as TranscriptTurn
}
const pending = (key: string, text: string): PendingSend => ({ id: `pending:${key}`, text, baseline: new Set<string>(), accepted: true })

// queued = 那台机器上还排着的(时间线的 queuedPrompts):它们和手机刚发的一样是乐观行,被记录行顶掉时同一个坑。
type Step = { turns: TranscriptTurn[]; pending: PendingSend[]; queued?: { id: string; text: string }[] }

function view({ turns, pending: sends, queued = [] }: Step) {
  return (
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns, queuedPrompts: queued }}
      deviceId="device-1"
      sessionId="session-1"
      sessionRuntime="acp"
      respondingItemId={null}
      onRespond={() => undefined}
      onSend={async () => undefined}
      pendingSends={sends}
      sending={false}
      agentWorking={false}
      onStop={() => undefined}
      stopping={false}
      footerNotice={<BranchProbe />}
      onLoadOlder={async () => undefined}
    />
  )
}

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  Element.prototype.scrollTo = scrollTo
})

function readBranches(): string[] {
  const probe = harness.container.querySelector('[data-testid="branch-probe"]')
  // 探针没挂上 = 下面「全是 1」的判据根本没执行;响亮失败,❌ 当成「没有兄弟」。
  if (!probe) throw new Error('branch probe did not render inside the AgentThread runtime')
  return (probe.getAttribute('data-branches') ?? '').split(' ').filter(Boolean)
}
const userTexts = () => [...harness.container.querySelectorAll('[data-role="user"]')].map((row) => row.textContent?.trim())
const expectedUserTexts = ({ turns, pending: sends, queued = [] }: Step) => [
  ...turns.flatMap((t) => (t.items as unknown as Array<{ role: string; text: string }>).filter((i) => i.role === 'user').map((i) => i.text)),
  ...queued.map((q) => q.text),
  ...sends.map((s) => s.text),
]

async function walk(steps: Step[]) {
  const readings: string[][] = []
  for (const step of steps) {
    await harness.render(view(step))
    const branches = readBranches()
    readings.push(branches)
    expect(branches.length, 'the runtime sees the thread').toBeGreaterThan(0)
    // 一条消息一行:任何一条有同父兄弟,就是「‹ 2/2 ›」的来源。
    expect(branches.filter((entry) => !entry.endsWith(':1')), `siblings after step ${readings.length}`).toEqual([])
    expect(userTexts()).toEqual(expectedUserTexts(step))
    expect(harness.container.querySelector('.aui-branch-picker-root')).toBeNull()
  }
  return readings
}

const t0 = () => turn('t0', [['user', 'u0', 'earlier'], ['assistant', 'a0', 'reply']])
const tUser = (key: string, text: string) => turn(`t${key}`, [['user', `r${key}`, text]])
const A = pending('A', 'A'), B = pending('B', 'B'), C = pending('C', 'C')

describe('#6901 手机看会话:发得急时一条消息仍只有一行(运行时仓库里没有兄弟)', () => {
  it('阳控:探针读得出兄弟 —— 两条同父的行喂进运行时,branchCount 是 2', async () => {
    function Sibling() {
      const runtime = useExternalStoreRuntime<ThreadMessage>({
        messageRepository: ExportedMessageRepository.fromBranchableArray(
          [
            { message: { id: 'x', role: 'user', content: 'x' }, parentId: null },
            { message: { id: 'y1', role: 'user', content: 'y' }, parentId: 'x' },
            { message: { id: 'y2', role: 'user', content: 'y' }, parentId: 'x' },
          ],
          { headId: 'y2' },
        ),
        onNew: async () => undefined,
      })
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <BranchProbe />
        </AssistantRuntimeProvider>
      )
    }
    await harness.render(<Sibling />)
    expect(readBranches()).toEqual(['x:1', 'y2:2'])
  })

  it('1 连发 A、B,A 的记录先回来(B 还在路上),之后 B 回来、agent 回话', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0(), tUser('A', 'A')], pending: [B] },
      { turns: [t0(), tUser('A', 'A'), tUser('B', 'B')], pending: [] },
      { turns: [t0(), tUser('A', 'A'), turn('tB', [['user', 'rB', 'B'], ['assistant', 'b1', 'ok']])], pending: [] },
    ])
  })

  it('2 连发 A、B,B 的记录先回来', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0(), tUser('B', 'B')], pending: [A] },
      { turns: [t0(), tUser('B', 'B'), tUser('A', 'A')], pending: [] },
    ])
  })

  it('3 A、B 被终端腿并成一行回来', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0(), tUser('AB', 'A B')], pending: [] },
    ])
  })

  it('4a A 发送失败(从中间撤掉)、B 还在路上,随后 B 回来', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0()], pending: [B] },
      { turns: [t0(), tUser('B', 'B')], pending: [] },
    ])
  })

  it('4b B 已经回来之后 A 才失败', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0(), tUser('B', 'B')], pending: [A] },
      { turns: [t0(), tUser('B', 'B')], pending: [] },
    ])
  })

  it('5a 重连后整份重放,记录 id 不变', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0(), tUser('A', 'A'), tUser('B', 'B')], pending: [] },
      { turns: [t0(), tUser('A', 'A'), tUser('B', 'B')], pending: [] },
    ])
  })

  it('5b 重连后记录换了世代,id 全换', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0(), tUser('A', 'A'), tUser('B', 'B')], pending: [] },
      {
        turns: [
          turn('t0n', [['user', 'u0n', 'earlier'], ['assistant', 'a0n', 'reply']]),
          turn('tAn', [['user', 'rAn', 'A']]),
          turn('tBn', [['user', 'rBn', 'B']]),
        ],
        pending: [],
      },
    ])
  })

  it('6 连发三句,记录逐句回来', async () => {
    await walk([
      { turns: [t0()], pending: [A, B, C] },
      { turns: [t0(), tUser('A', 'A')], pending: [B, C] },
      { turns: [t0(), tUser('A', 'A'), tUser('B', 'B')], pending: [C] },
      { turns: [t0(), tUser('A', 'A'), tUser('B', 'B'), tUser('C', 'C')], pending: [] },
    ])
  })

  it('7 连发 A、B 时 agent 在忙:A 进了那台机器的队列,B 还在路上,随后 A 被接走', async () => {
    await walk([
      { turns: [t0()], pending: [A, B] },
      { turns: [t0()], queued: [{ id: 'qA', text: 'A' }], pending: [B] },
      { turns: [t0(), tUser('A', 'A')], pending: [B] },
    ])
  })

  it('8 队列里排着 A、B,A 先被接走,B 还排着', async () => {
    await walk([
      { turns: [t0()], queued: [{ id: 'qA', text: 'A' }, { id: 'qB', text: 'B' }], pending: [] },
      { turns: [t0(), tUser('A', 'A')], queued: [{ id: 'qB', text: 'B' }], pending: [] },
      { turns: [t0(), tUser('A', 'A'), tUser('B', 'B')], pending: [] },
    ])
  })
})
