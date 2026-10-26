import './phone-memory.css'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DirectoryEntry } from '@shared/core/fs/fs'
import { Markdown } from '@/components/markdown/Markdown'
import { useToast } from '@/components/toastContext'
import { Button } from '@/components/ui/Button'
import { ArrowUpToLine, File, Folder, Sparkles, Trash2 } from '@/lib/icons'
import { RESOURCES_DIR_NAME, joinPath } from '@/session/renderer/features/assistant/assistant-files'
import { removePath } from '@/session/renderer/features/assistant/assistant-machine-core'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { PhoneMachineView, ReadView, type OpenedPageProps } from './PhoneMachineView'
import { filesSub, formatSize, readResourceView, resourceDisplayPath, uploadResources, visibleEntries, type FileContentView } from './phoneMemoryData'
import { errorText, machineKey, usePhoneRead } from './usePhoneRead'

/**
 * 记忆 → 给助理的资料(照桌面 ResourceFiles):`files` 是那一夹,`files:<相对路径>` 往下钻 —— 文件夹列出来,文件打开看(只读)。
 * 从手机传文件进来(与桌面同一套规矩、同一个分块上传),传完「让它去看」只把一句话填进聊天。文件能删(先确认);改名、建夹留给电脑。
 * 醒着才读得到(❌ 自己叫醒)。
 */
export function PhoneFiles(props: PhonePageProps & { trail: string[] }) {
  const ready = props.machine.state === 'ready' ? props.machine.machine : null
  if (ready) return <ResourcePage key={`${machineKey(ready)}|${props.trail.join('/')}`} {...props} machine={ready} />
  return (
    <div className="ta-page" data-testid="assistant-files">
      <PageHead title={props.trail.at(-1) ?? RESOURCES_DIR_NAME} />
      <PhoneMachineView machine={props.machine} name={props.assistant.display_name}>
        {() => null}
      </PhoneMachineView>
    </div>
  )
}

function ResourcePage(props: OpenedPageProps & { trail: string[] }) {
  const { t } = useTranslation('assistant')
  const { machine, trail } = props
  // Directory reloads unmount the list; keep completed uploads with this directory.
  const [uploaded, setUploaded] = useState<string[]>([])
  const read = usePhoneRead(`files|${machineKey(machine)}|${trail.join('/')}`, () => readResourceView(machine, trail), 'read resource files')
  if (read.state === 'ok' && read.data.kind === 'folder') return <FolderView {...props} entries={read.data.entries} reload={read.reload} uploaded={uploaded} onUploaded={setUploaded} />
  if (read.state === 'ok' && read.data.kind === 'file') return <FileView {...props} entry={read.data.entry} content={read.data.content} />
  return (
    <div className="ta-page" data-testid="assistant-files">
      <PageHead title={trail.at(-1) ?? RESOURCES_DIR_NAME} />
      <ReadView read={read} failedTitle={t('files.loadFailed')}>
        {() => <AssistantEmpty title={t('files.goneTitle')}>{t('files.gone')}</AssistantEmpty>}
      </ReadView>
    </div>
  )
}

function FolderView({
  machine,
  trail,
  assistant,
  askInChat,
  go,
  entries,
  reload,
  uploaded,
  onUploaded,
}: OpenedPageProps & { trail: string[]; entries: DirectoryEntry[]; reload: () => void; uploaded: string[]; onUploaded: (files: string[]) => void }) {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  const name = assistant.display_name
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const where = resourceDisplayPath(machine, trail)
  const shown = visibleEntries(entries)
  const upload = async (files: File[]) => {
    if (!files.length) return
    setUploading(files[0]!.name)
    try {
      const outcome = await uploadResources(machine, trail, files, setUploading)
      const failures = [...outcome.rejected.map(rejected => `${rejected.name}: ${rejected.reason === 'too_large' ? t('files.tooLarge') : t('files.unsupported')}`),
        ...outcome.failed.map(failed => `${failed.name}: ${errorText(new Error(failed.message))}`)]
      if (failures.length) toast(`${t('files.saveFailed')}\n${failures.join('\n')}`, 'error')
      if (outcome.done.length) {
        for (const name of outcome.done) await reportAssistantAppChange(machine, assistant.id, { resource: 'files', operation: 'saved',
          id: joinPath(machine.paths.resourcesDir, [...trail, name].join('/')), deviceId: machine.deviceId,
          after: { name, path: joinPath(machine.paths.resourcesDir, [...trail, name].join('/')) } })
        onUploaded([...new Set([...uploaded, ...outcome.done])])
        if (!failures.length) toast(t('files.uploaded', { n: outcome.done.length }), 'success')
        reload()
      }
    } catch (error) {
      // 资料夹没建成(第一次传之前它不存在):一个都没传。
      toast(t('files.uploadFailed', { name: where, message: errorText(error) }), 'error')
    } finally {
      setUploading(null)
    }
  }
  return (
    <div className="ta-page" data-testid="assistant-files">
      <PageHead
        title={trail.at(-1) ?? RESOURCES_DIR_NAME}
        sub={trail.length ? where : t('files.note', { name, folder: RESOURCES_DIR_NAME })}
        action={
          <Button variant="ghost" className="ta-pill-btn shrink-0" disabled={!!uploading} onClick={() => input.current?.click()} data-testid="assistant-files-upload">
            <ArrowUpToLine />
            {uploading ? t('files.uploading', { name: uploading }) : t('files.upload')}
          </Button>
        }
      />
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        data-testid="assistant-files-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void upload(files)
        }}
      />
      {uploaded.length ? (
        <div className="ta-card ta-banner">
          <Sparkles className="ta-banner-icon" />
          <span className="min-w-0 flex-1">{t('files.uploadedBanner', { files: uploaded.join('、') })}</span>
          <Button
            variant="ghost"
            className="ta-pill-btn shrink-0"
            data-testid="assistant-files-analyze"
            onClick={() => {
              askInChat(t('files.analyzePrompt', { path: where, files: uploaded.join('、') }))
              onUploaded([])
            }}
          >
            {t('files.analyze', { name })}
          </Button>
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className="ta-card">
          <AssistantEmpty>{trail.length ? t('files.folderEmpty') : t('files.empty', { name })}</AssistantEmpty>
        </div>
      ) : (
        <AssistantSection>
          {shown.map((entry) => {
            const folder = entry.type === 'directory'
            return (
              <AssistantRow
                key={entry.path}
                testId={`assistant-file-${entry.name}`}
                leading={folder ? <Folder className="ta-file-icon" /> : <File className="ta-file-icon" />}
                title={entry.name}
                detail={folder ? undefined : formatSize(entry.size)}
                onClick={() => go(filesSub([...trail, entry.name]))}
              />
            )
          })}
        </AssistantSection>
      )}
    </div>
  )
}

/** 打开一个文件看(只读):文本原样 / Markdown 照排;不是文本、太大如实说。下面「让它去看」(填进聊天)、删除(先确认)。 */
function FileView({
  machine,
  trail,
  assistant,
  askInChat,
  go,
  entry,
  content,
}: OpenedPageProps & { trail: string[]; entry: DirectoryEntry; content: FileContentView }) {
  const { t, i18n } = useTranslation('assistant')
  const { toast } = useToast()
  const [confirming, setConfirming] = useState(false)
  const name = assistant.display_name
  const parent = trail.slice(0, -1)
  const modified = new Date(entry.modifiedAt as unknown as string)
  const sub = [
    formatSize(entry.size),
    Number.isNaN(modified.getTime())
      ? null
      : t('memory.updated', {
          time: new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(modified),
        }),
  ]
    .filter(Boolean)
    .join(' · ')
  const body = (() => {
    if (content.kind === 'binary')
      return (
        <div className="ta-card">
          <AssistantEmpty>{t('files.notText')}</AssistantEmpty>
        </div>
      )
    if (content.kind === 'too-large')
      return (
        <div className="ta-card">
          <AssistantEmpty>{t('files.tooBigToView', { size: formatSize(content.size) })}</AssistantEmpty>
        </div>
      )
    if (!content.text.trim())
      return (
        <div className="ta-card">
          <AssistantEmpty>{t('memory.noContent')}</AssistantEmpty>
        </div>
      )
    if (/\.(md|markdown)$/i.test(entry.name))
      return (
        <div className="ta-card ta-prose" data-testid="assistant-file-body">
          <Markdown trust="chat" content={content.text} />
        </div>
      )
    return (
      <div className="ta-card" data-testid="assistant-file-body">
        <pre className="ta-phone-file-text">{content.text}</pre>
      </div>
    )
  })()
  return (
    <div className="ta-page" data-testid="assistant-file">
      <PageHead title={entry.name} sub={sub} />
      {body}
      <div className="ta-phone-row-actions">
        <Button
          variant="ghost"
          className="ta-pill-btn"
          onClick={() => askInChat(t('files.analyzePrompt', { path: resourceDisplayPath(machine, parent), files: entry.name }))}
          data-testid="assistant-file-analyze"
        >
          <Sparkles />
          {t('files.analyze', { name })}
        </Button>
        <Button variant="ghost" className="ta-pill-btn" data-tone="danger" onClick={() => setConfirming(true)} data-testid="assistant-file-delete">
          <Trash2 />
          {t('common.delete')}
        </Button>
      </div>
      <PhoneConfirmDialog
          open={confirming}
          title={t('files.deleteFileTitle')}
          body={t('files.deleteFileBody', { name: entry.name })}
          confirmLabel={t('common.delete')}
          failedText={t('files.deleteFailed')}
          testId="assistant-file-delete-dialog"
          onClose={() => setConfirming(false)}
          onConfirmed={() => go(filesSub(parent))}
          onConfirm={async () => {
            await removePath(machine, entry.path)
            await reportAssistantAppChange(machine, assistant.id, { resource: 'files', operation: 'removed',
              id: entry.path, deviceId: machine.deviceId, before: { name: entry.name, path: entry.path } })
            toast(t('files.fileDeleted'), 'success')
          }}
        />

    </div>
  )
}
