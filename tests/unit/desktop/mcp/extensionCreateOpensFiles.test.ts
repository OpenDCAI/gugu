// 摩擦单 F1(L5,09-29):app_create 的 opens_files 以前只收纯数组 —— manifest 只认任务文件,
// agent 读了 guide 知道群里的文件要写 { group: [...] },工具却写不出来,只好先 Read 再 Edit 手改 manifest。
// S1 之后工具这一面不再展开 opensFiles 的 schema(create 压到 500 token 以内):原样交给动作层,由 manifest 自己的
// schema 收或拒(那几格在 extension-agent-actions.test.ts)。这里守的是工具这一面:什么写法都放行、并且说清群里怎么写。
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EXTENSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'

const create = EXTENSION_TOOL_DEFS.find((def) => def.name === 'app_create')!
const args = (opensFiles: unknown) => ({ target_dir: 'poll', id: 'poll', name: 'Poll', template: 'group-json', opens_files: opensFiles })

describe('app_create: opens_files goes down as written, for the manifest to judge', () => {
  it.each([
    ['task files', { session: ['.md'] }],
    ['chat files', { chat: ['.md', '.json'] }],
    ['a wrong one, which the manifest refuses below', { chat: ['md'] }],
  ])('the tool passes %s', (_, opensFiles) => {
    const parsed = (create.schema as z.ZodTypeAny).safeParse(args(opensFiles))
    expect(parsed.success).toBe(true)
    expect((parsed.data as { opens_files: unknown }).opens_files).toEqual(opensFiles)
  })
})
