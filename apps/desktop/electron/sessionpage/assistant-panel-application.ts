import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { assistantHomePaths, type AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'
import { composeInstructions } from '@gugu/core/shared/assistantInstructions'
import { atomicWriteText } from '@gugu/core/local/state/paths'
import type { AssistantPanelChange } from '@gugu/core/cloud/assistantPanel'
import type { PanelApplication } from './assistant-panel-admission'
import { assistantPanelPath } from './assistant-panel-paths'
import { panelApplicationFailure } from '@gugu/core/shared/assistantPanelFailure'

type Notice = { operationId: string; resource: string; context: Record<string, unknown> }
type LocalState = { version: 1; ownerId: string; assistantId: string; revokedPaths: string[]; revokedKeys: string[]; paths: Record<string, string[]>;
  acceptedFailures?: string[]; appliedRevisions?: Record<string, string>; revokedResources?: Record<string, { domain: string; paths: string[] }>; notices: Notice[] }
export type AssistantPanelHome = { assistantId: string; ownerId: string; cwd: string; home: string; kind: AssistantHomeKind }

const keyOf = (change: AssistantPanelChange) => JSON.stringify([change.domain,change.resource_key])
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PANEL_DATA_INVALID')
  return value as Record<string, unknown>
}
async function optionalText(path: string): Promise<string> {
  try { return await readFile(path,'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}

/** Delete index lines which actually resolve to the revoked memory file. */
export function removePanelMemoryReferences(index: string, directory: string, paths: readonly string[]): string {
  const deleted = new Set(paths.map(path => resolve(path)))
  return index.split('\n').filter(line => ![...line.matchAll(/\]\((<[^>]+>|[^)]+)\)/g)].some(match => {
    const raw = match[1]!.startsWith('<') ? match[1]!.slice(1,-1) : match[1]!.split(/\s+["']/)[0]!
    try { return deleted.has(resolve(directory,decodeURIComponent(raw))) } catch { return false }
  })).join('\n')
}

/** Effects and structured notices share a durable local ledger. The ledger is
 * inside memory so adoption carries it with the assistant's own files. It never
 * replaces native history, changes its prefix, or contains deleted note bodies. */
export function createAssistantPanelApplication(binding: AssistantPanelHome, deps: {
  assertCurrent(): Promise<void>
  readBody(change: AssistantPanelChange): Promise<Uint8Array>
  applyService(change: AssistantPanelChange): Promise<void>
  invalidate(): Promise<void>
  resourceChanged?(operationId: string, notice: Record<string, unknown>): Promise<boolean>
  locale?(): string
}): PanelApplication & { statePath: string; identify(domain: string, path: string): Promise<string>; remember(domain: string, rows: Array<{ key: string; path: string }>): Promise<void> } {
  const paths = assistantHomePaths(binding.home,binding.cwd,binding.kind)
  const anchor = binding.kind === 'cloud' ? binding.home : binding.cwd
  const stateName = `.panel-state-${createHash('sha256').update(JSON.stringify([binding.ownerId,binding.assistantId])).digest('hex').slice(0,24)}.json`
  const statePath = join(paths.memoryDir,stateName)
  const rootOf = (domain: string) => domain === 'memory' ? paths.memoryDir : domain === 'files' ? paths.resourcesDir
    : domain === 'skills' ? paths.skillsDir : domain === 'voice-notes' ? join(paths.memoryDir,'voice-notes') : null
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.catch(() => undefined).then(work)
    tail = result
    return result
  }
  async function state(): Promise<LocalState> {
    const text = await optionalText(statePath)
    if (!text) return { version: 1,ownerId: binding.ownerId,assistantId: binding.assistantId,revokedPaths: [],revokedKeys: [],paths: {},notices: [] }
    const value = JSON.parse(text) as LocalState
    if (value.version !== 1 || value.ownerId !== binding.ownerId || value.assistantId !== binding.assistantId
      || !Array.isArray(value.revokedPaths) || !Array.isArray(value.revokedKeys)
      || !value.paths || typeof value.paths !== 'object' || Array.isArray(value.paths) || !Array.isArray(value.notices)
      || Object.values(value.paths).some(paths => !Array.isArray(paths) || paths.some(path => typeof path !== 'string'))
      || (value.acceptedFailures !== undefined && (!Array.isArray(value.acceptedFailures) || value.acceptedFailures.some(id => typeof id !== 'string')))
      || value.revokedPaths.some(path => typeof path !== 'string') || value.revokedKeys.some(key => typeof key !== 'string')) {
      throw new Error('PANEL_LEDGER_INVALID')
    }
    // Adoption changes absolute roots. Keep prior aliases denied and materialize
    // the same revocations at this home's paths before installing native hooks.
    for (const revoked of Object.values(value.revokedResources ?? {})) {
      const root = rootOf(revoked.domain)
      if (!root || !Array.isArray(revoked.paths)) throw new Error('PANEL_LEDGER_INVALID')
      for (const path of revoked.paths) value.revokedPaths.push(await assistantPanelPath(root,path,{ home: anchor }))
    }
    value.revokedPaths = [...new Set(value.revokedPaths)]
    return value
  }
  async function save(value: LocalState) {
    await deps.assertCurrent()
    const target = await assistantPanelPath(paths.memoryDir,stateName,{ home: anchor,createParents: true })
    await atomicWriteText(target,`${JSON.stringify(value)}\n`)
  }
  async function replace(path: string, bytes: Uint8Array) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary,bytes,{ mode: 0o600 })
      await deps.assertCurrent()
      await rename(temporary,path)
    } finally { await rm(temporary,{ force: true }) }
  }
  async function inform(change: AssistantPanelChange) {
    await deps.assertCurrent()
    if (change.assistant_user_id !== binding.assistantId || change.owner_user_id !== binding.ownerId) throw new Error('PANEL_ACCOUNT_CHANGED')
    const value = await state()
    if (change.payload.failure) {
      const failure = object(change.payload.failure)
      if (typeof failure.operationId !== 'string' || typeof failure.domain !== 'string' || typeof failure.resourceKey !== 'string'
        || typeof failure.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.errorCode)) throw new Error('PANEL_DATA_INVALID')
      if (value.acceptedFailures?.includes(failure.operationId)) return
      const locale = deps.locale?.() ?? 'zh-CN', resource = `failure:${failure.operationId}`
      value.notices = value.notices.filter(entry => entry.resource !== resource)
      value.notices.push({ operationId: change.operation_id,resource,context: {
        type: 'assistant_panel_application_failed',...failure,
        message: panelApplicationFailure(failure.domain,typeof failure.name === 'string' ? failure.name : failure.resourceKey,failure.errorCode,locale,String(failure.operation)),
        instruction: locale.startsWith('en')
          ? 'Explain this failed change and its reason once in the next reply, then continue the request. Unapplied saved values are not current state; deleted content must not be used as evidence.'
          : '在下一次回复中说明一次这项变更未能完成及原因，然后继续处理当前请求。未应用的保存值不是当前状态；已删除的内容不得再作为有效依据。',
      } })
      await save(value)
      return
    }
    const notice = object(change.payload.notice)
    if (await deps.resourceChanged?.(change.operation_id, notice)) return
    const resource = `notice:${JSON.stringify([notice.resource,notice.id])}`
    value.notices = value.notices.filter(entry => entry.resource !== resource)
    value.notices.push({ operationId: change.operation_id,resource,context: { type: 'assistant_app_change',...notice } })
    await save(value)
  }
  async function apply(change: AssistantPanelChange) {
    await deps.assertCurrent()
    if (change.assistant_user_id !== binding.assistantId || change.owner_user_id !== binding.ownerId) throw new Error('PANEL_ACCOUNT_CHANGED')
    const value = await state(), key = keyOf(change), removed = change.operation === 'remove'
    const data = object(change.payload[removed ? 'before' : 'data'] ?? {})
    if (BigInt(change.revision) < BigInt(value.appliedRevisions?.[key] ?? '0')) return
    const recreated = change.payload.recreated === true
    if (!removed && value.revokedKeys.includes(key) && !recreated) throw new Error('RESOURCE_DELETED')
    let text: string | undefined
    const root = rootOf(change.domain)
    if (root) {
      const relativeName = change.domain === 'memory' ? data.relativePath : change.domain === 'files' ? data.path
        : change.domain === 'voice-notes' ? change.resource_key : `${change.resource_key}/SKILL.md`
      if (typeof relativeName === 'string' && relativeName.split('/').some(part => part.startsWith('.panel-state-'))) throw new Error('PANEL_RESERVED_PATH')
      const target = relativeName === undefined && removed ? null : await assistantPanelPath(root,relativeName,{ home: anchor,createParents: !removed })
      if (removed) {
        const previous = await Promise.all((value.paths[key] ?? []).map(path => assistantPanelPath(root,path,{ home: anchor })))
        const deleting = [...new Set([...previous,...(target ? [target] : [])])]
        // Persist revocation before deleting files. Read/Write hooks can deny the
        // old path even if cleanup fails halfway through and this turn is refused.
        value.revokedKeys = [...new Set([...value.revokedKeys,key])]
        value.revokedPaths = [...new Set([...value.revokedPaths,...deleting])]
        value.revokedResources ??= {}
        value.revokedResources[key] = { domain: change.domain,paths: deleting.map(path => relative(root,path).split('\\').join('/')) }
        await save(value)
        for (const path of deleting) {
          const checked = await assistantPanelPath(root,relative(root,path).split('\\').join('/'),{ home: anchor })
          await rm(checked,{ recursive: true,force: true })
        }
        if (change.domain === 'memory') {
          const index = await assistantPanelPath(paths.memoryDir,'MEMORY.md',{ home: anchor })
          const original = await optionalText(index)
          const next = removePanelMemoryReferences(original,paths.memoryDir,deleting)
          if (next !== original) await atomicWriteText(index,next)
        }
        delete value.paths[key]
      } else {
        if (value.revokedPaths.some(path => path !== target && target!.startsWith(`${path}${sep}`))) throw new Error('RESOURCE_DELETED')
        const previous = await Promise.all((value.paths[key] ?? []).map(path => assistantPanelPath(root,path,{ home: anchor })))
        const replaced = previous.filter(path => path !== target)
        if (replaced.length) {
          value.revokedPaths = [...new Set([...value.revokedPaths,...replaced])]
          value.revokedResources ??= {}
          value.revokedResources[`replaced:${key}`] = { domain: change.domain,paths: [...new Set([
            ...(value.revokedResources[`replaced:${key}`]?.paths ?? []),...replaced.map(path => relative(root,path).split('\\').join('/')),
          ])] }
          await save(value)
          for (const path of replaced) await rm(path,{ recursive: true,force: true })
          if (change.domain === 'memory') {
            const index = await assistantPanelPath(root,'MEMORY.md',{ home: anchor })
            const original = await optionalText(index)
            const next = removePanelMemoryReferences(original,root,replaced)
            if (original !== next) await atomicWriteText(index,next)
          }
        }
        if ((change.domain === 'files' || change.domain === 'voice-notes') && data.kind === 'directory') await mkdir(target!,{ recursive: true,mode: 0o700 })
        else await replace(target!,await deps.readBody(change))
        value.paths[key] = [relative(root,target!).split('\\').join('/')]
        // Owner intent supplies new content at this exact path. Sibling paths
        // remain revoked; older revisions cannot delete this new generation.
        value.revokedKeys = value.revokedKeys.filter(candidate => candidate !== key)
        value.revokedPaths = value.revokedPaths.filter(path => path !== target)
        for (const entry of Object.values(value.revokedResources ?? {})) {
          const entryRoot = rootOf(entry.domain)
          if (entryRoot) entry.paths = entry.paths.filter(path => resolve(entryRoot,path) !== target)
        }
      }
    } else if (change.domain === 'personality') {
      text = removed ? '' : typeof data.text === 'string' ? data.text : new TextDecoder('utf-8',{ fatal: true }).decode(await deps.readBody(change))
      const root = dirname(paths.instructions)
      const target = await assistantPanelPath(root,'CLAUDE.md',{ home: anchor,createParents: true })
      await atomicWriteText(target,composeInstructions(await optionalText(target),text))
    } else await deps.applyService(change)
    await deps.invalidate()
    value.appliedRevisions ??= {}
    value.appliedRevisions[key] = change.revision
    value.notices = value.notices.filter(entry => entry.resource !== key)
    const resourceChanged = await deps.resourceChanged?.(change.operation_id, { resource: change.domain,
      id: data.relativePath ?? change.resource_key, deviceId: change.device_id,
      operation: removed ? 'removed' : 'saved', [removed ? 'before' : 'after']: data })
    if (!resourceChanged) value.notices.push({ operationId: change.operation_id,resource: key,context: {
      type: 'assistant_panel_change',operationId: change.operation_id,revision: change.revision,
      domain: change.domain,resourceKey: change.resource_key,operation: change.operation,
      ...(removed ? { instruction: change.domain === 'memory' ? '这条记忆已被主人删除，不再作为依据。' : '这条资料已被主人删除，不再作为依据。' } : {}),
      ...(text !== undefined ? { personality: text,instruction: '主人已修改性格约定；从本轮起按当前约定处理。' } : {}),
    } })
    await save(value)
  }
  return {
    statePath,
    remember: (domain,rows) => serial(async () => {
      const root = rootOf(domain)
      if (!root) return
      const value = await state()
      let changed = false
      for (const row of rows) {
        const key = JSON.stringify([domain,row.key])
        if (value.paths[key] || value.revokedKeys.includes(key)) continue
        await assistantPanelPath(root,row.path,{ home: anchor })
        value.paths[key] = [row.path]; changed = true
      }
      if (changed) await save(value)
    }),
    identify: (domain,path) => serial(async () => {
      const value = await state()
      const known = Object.entries(value.paths).find(([key,paths]) => JSON.parse(key)[0] === domain && paths.includes(path))
      return known ? JSON.parse(known[0])[1] : path
    }),
    apply: change => serial(() => apply(change)),
    inform: change => serial(() => inform(change)),
    prepareText: text => serial(async () => {
      await deps.assertCurrent()
      const value = await state(), included = new Set(value.notices.map(notice => notice.operationId))
      await save(value)
      const context = value.notices.map(notice => JSON.stringify(notice.context)).join('\n')
      const heading = (deps.locale?.() ?? 'zh-CN').startsWith('en')
        ? 'Panel changes and their outcomes follow. Preserve the full conversation; deleted content is no longer valid evidence.'
        : '面板操作及处理结果如下。保留完整聊天；删除的内容不再作为有效依据。'
      return { text: context ? `${heading}\n${context}\n\n${text}` : text,
        accepted: () => serial(async () => {
          const current = await state()
          const failures = current.notices.filter(notice => included.has(notice.operationId) && notice.resource.startsWith('failure:')).map(notice => notice.resource.slice('failure:'.length))
          current.acceptedFailures = [...new Set([...(current.acceptedFailures ?? []),...failures])]
          current.notices = current.notices.filter(notice => !included.has(notice.operationId))
          await save(current)
        }),
      }
    }),
  }
}
