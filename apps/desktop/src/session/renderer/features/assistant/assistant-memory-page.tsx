import { messageForUser } from '@/lib/userFacingError';
import { rendererLogger } from '@/lib/log';
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpToLine, File, Folder, FolderPlus, Heart, Mic, MoreHorizontal, Plus, Sparkles, SquarePen, Trash2 } from '@/lib/icons';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { Input } from '@renderer/lib/ui/input';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import type { DirectoryEntry } from '@shared/core/fs/fs';
import { folderNameProblem, isOwnerProfileNote, joinPath, removeIndexEntry, resourceRejection, RESOURCES_DIR_NAME, type MemoryKind } from './assistant-files';
import { makeFolder, readText, removePath, renamePath, uploadFile, writeText } from './assistant-machine';
import { useDirectory, useInvalidateAssistant, useMemoryNotes, type MemoryEntry } from './assistant-data';
import type { AssistantContext, AssistantPageProps } from './assistant-context';
import { AssistantEmpty, AssistantRow, AssistantSection, MachineGate, ownerLeading, PageHead, Tile } from './assistant-ui';
import { AssistantHealthPage } from './assistant-health';
import { useVoiceNotes } from './voice-notes/voice-notes-data';
import { VOICE_NOTE_SUB, VoiceNotesPage } from './voice-notes/voice-notes-pages';
import { AssistantLibraryCard, AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';

function useTimeFormat() {
  const { i18n } = useTranslation();
  return (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '';
}

function kindLabel(kind: MemoryKind, t: (key: string, options?: Record<string, unknown>) => string, name: string): string {
  if (kind === 'user') return t('memory.filter.user');
  if (kind === 'feedback') return t('memory.filter.assistant', { name });
  if (kind === 'project') return t('memory.kind.project');
  if (kind === 'reference') return t('memory.kind.reference');
  return t('memory.filter.other');
}

/**
 * 记忆首页:页头「记忆 +」→「我对 X 的了解」那张卡(它记下的关于你的那几条)→「全部」两列小卡:
 * 录音笔记、给它的资料(一个文件夹)、其余每一条记忆。点进去是往下钻的那一页。
 */
function MemoryHome({ context }: { context: AssistantContext }) {
  const { t } = useTranslation('assistant');
  const time = useTimeFormat();
  const notes = useMemoryNotes(context.machine);
  const root = useDirectory(context.machine, context.machine?.paths.resourcesDir ?? null);
  const name = context.assistant.display_name;
  const all = notes.data?.notes ?? [];
  const aboutYou = all.filter((n) => n.kind === 'user');
  const others = all.filter((n) => n.kind !== 'user');
  const latest = aboutYou.map((n) => n.modifiedAt).filter(Boolean).sort().at(-1) ?? null;
  const fileCount = (root.data ?? []).filter((entry) => !entry.name.startsWith('.')).length;
  const voice = useVoiceNotes(context.machine);
  const voiceCount = voice.data?.length ?? 0;
  return (
    <div className="ta-page" data-testid="assistant-memory">
      <PageHead
        title={t('nav.memory')}
        action={
          <button type="button" className="ta-circle" aria-label={t('files.upload')} title={t('files.upload')} onClick={() => context.go({ tab: 'memory', sub: 'files' })} data-testid="assistant-memory-add">
            <Plus />
          </button>
        }
      />
      <MachineGate
        readiness={context.readiness}
        loading={context.machineLoading || notes.isLoading}
        error={context.machineError ?? notes.error}
        onRetry={() => (context.machineError ? context.retryMachine() : void notes.refetch())}
      >
        <AssistantSection title={t('library.longTerm')} testId="assistant-memory-about">
          {aboutYou.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <button type="button" className="ta-pill-btn" onClick={() => context.askInChat(t('memory.fasterPrompt'))} data-testid="assistant-memory-ask">
                <Sparkles />
                {t('memory.faster')}
              </button>
            </div>
          ) : (
            aboutYou.map(note => <AssistantRow key={note.file} leading={ownerLeading(context.owner)} title={isOwnerProfileNote(note) ? t('memory.filter.user') : note.title} detailLines={4}
              detail={note.description || (latest ? t('memory.updated', { time: time(latest) }) : undefined)}
              onClick={() => context.go({ tab: 'memory', sub: `note:${note.file}` })} />)
          )}
        </AssistantSection>
        <AssistantSection title={t('library.workspace')}>
          <AssistantLibraryCard assistantId={context.assistant.id} machine={context.machine} kind="workspace" onOpen={() => context.go({ tab: 'memory', sub: 'library:workspace' })} />
        </AssistantSection>
        {others.length > 0 && <AssistantSection title={t('library.memory')} bare testId="assistant-memory-all">
          <div className="ta-grid">
            {others.map((note) => (
              <Tile
                key={note.file}
                title={note.title}
                sub={note.modifiedAt ? t('memory.updated', { time: time(note.modifiedAt) }) : kindLabel(note.kind, t, name)}
                preview={note.description || note.body.slice(0, 140)}
                onClick={() => context.go({ tab: 'memory', sub: `note:${note.file}` })}
                testId={`assistant-memory-${note.file}`}
              />
            ))}
          </div>
        </AssistantSection>}
        <AssistantSection title={t('library.sources')}>
          <AssistantRow leading={<Heart />} title={t('health.title')} onClick={() => context.go({ tab: 'memory', sub: 'health' })} testId="assistant-memory-health" />
          <AssistantRow leading={<Mic />} title={t('memory.voiceNotes')} detail={voiceCount > 0 ? t('memory.items', { n: voiceCount }) : t('memory.voiceNotesCount')} onClick={() => context.go({ tab: 'memory', sub: VOICE_NOTE_SUB })} testId="assistant-memory-voice" />
          <AssistantRow leading={<Folder />} title={RESOURCES_DIR_NAME} detail={root.isSuccess ? t('memory.items', { n: fileCount }) : ''} onClick={() => context.go({ tab: 'memory', sub: 'files' })} testId="assistant-memory-files" />
        </AssistantSection>
      </MachineGate>
    </div>
  );
}

/** 一条记忆的全文(往下钻那一页):正文、在对话中改(填进聊天)、删(连同 MEMORY.md 里指向它的那一行)。 */
function MemoryNoteDetail({ context, file }: { context: AssistantContext; file: string }) {
  const { t } = useTranslation('assistant');
  const { toast } = useToast();
  const showConfirm = useShowModal('confirmActionModal');
  const invalidate = useInvalidateAssistant(context.homeDeviceId);
  const time = useTimeFormat();
  const notes = useMemoryNotes(context.machine);
  const note = notes.data?.notes.find((n) => n.file === file) ?? null;
  const remove = async (entry: MemoryEntry) => {
    const machine = context.machine!;
    try {
      await removePath(machine, entry.path);
      await reportAssistantAppChange(machine, context.assistant.id, { resource: 'memory', operation: 'removed',
        id: entry.path, deviceId: context.homeDeviceId, before: { name: entry.title, path: entry.path } });
      // 索引里指向它的那一行一起拿掉(MEMORY.md 是助理每次开工读的目录)。
      const index = machine.panel ? null : await readText(machine, machine.paths.memoryIndex);
      if (index !== null) {
        const next = removeIndexEntry(index, entry.file);
        if (next !== index) await writeText(machine, machine.paths.memoryIndex, next);
      }
      await invalidate('memory');
      toast({ title: t('memory.deleted') });
      context.go({ tab: 'memory' });
    } catch (error) { rendererLogger('actions/assistant-memory-page').error({ error: error }, 'action failed');
      toast({ title: t('memory.deleteFailed'), description: messageForUser(assistantPanelFailure(error,t)), tier: 'error' });
    }
  };
  return (
    <MachineGate
      readiness={context.readiness}
      loading={context.machineLoading || notes.isLoading}
      error={context.machineError ?? notes.error}
      onRetry={() => (context.machineError ? context.retryMachine() : void notes.refetch())}
    >
      {!note ? (
        <AssistantEmpty title={t('memory.goneTitle')}>{t('memory.gone')}</AssistantEmpty>
      ) : (
        <div className="ta-page" data-testid="assistant-memory-detail">
          <PageHead
            title={isOwnerProfileNote(note) ? t('memory.filter.user') : note.title}
            sub={[isOwnerProfileNote(note) ? null : kindLabel(note.kind, t, context.assistant.display_name), note.modifiedAt ? t('memory.updated', { time: time(note.modifiedAt) }) : null].filter(Boolean).join(' · ')}
          />
          <div className="ta-card ta-prose" data-testid="assistant-memory-body">
            <MarkdownRenderer content={note.body || t('memory.noContent')} />
          </div>
          <p className="ta-page-sub ta-pad">{t('memory.createdBy', { name: context.assistant.display_name })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ta-pill-btn" onClick={() => context.askInChat(isOwnerProfileNote(note) ? t('memory.editAboutMePrompt') : t('memory.editPrompt', { name: note.title }))}>
              <SquarePen />
              {t('memory.editInChat')}
            </button>
            <button
              type="button"
              className="ta-pill-btn"
              data-tone="danger"
              onClick={() =>
                showConfirm({
                  title: t('memory.deleteTitle'),
                  description: t('memory.deleteBody', { name: isOwnerProfileNote(note) ? t('memory.filter.user') : note.title }),
                  confirmLabel: t('common.delete'),
                  variant: 'destructive',
                  onSuccess: () => void remove(note),
                })
              }
            >
              <Trash2 />
              {t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </MachineGate>
  );
}

function ResourceRow({
  entry,
  context,
  onOpen,
}: {
  entry: DirectoryEntry;
  context: AssistantContext;
  onOpen: () => void;
}) {
  const { t } = useTranslation('assistant');
  const { toast } = useToast();
  const showConfirm = useShowModal('confirmActionModal');
  const invalidate = useInvalidateAssistant(context.homeDeviceId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(entry.name);
  const folder = entry.type === 'directory';
  const commitRename = async () => {
    const problem = folderNameProblem(name);
    if (problem) {
      toast({ title: problem === 'required' ? t('files.nameRequired') : t('files.nameSlash'), tier: 'error' });
      return;
    }
    setRenaming(false);
    if (name === entry.name) return;
    try {
      await renamePath(context.machine!, entry.path, name);
      await reportAssistantAppChange(context.machine, context.assistant.id, { resource: 'files', operation: 'edited',
        id: entry.path, deviceId: context.homeDeviceId, before: { name: entry.name, path: entry.path }, after: { name } });
      await invalidate('dir');
      toast({ title: t('files.renamed') });
    } catch (error) { rendererLogger('actions/assistant-memory-page').error({ error: error }, 'action failed');
      toast({ title: t('files.renameFailed'), description: messageForUser(assistantPanelFailure(error,t)), tier: 'error' });
    }
  };
  const remove = async () => {
    try {
      await removePath(context.machine!, entry.path, folder);
      await reportAssistantAppChange(context.machine, context.assistant.id, { resource: 'files', operation: 'removed',
        id: entry.path, deviceId: context.homeDeviceId, before: { name: entry.name, path: entry.path } });
      await invalidate('dir');
      toast({ title: folder ? t('files.folderDeleted') : t('files.fileDeleted') });
    } catch (error) { rendererLogger('actions/assistant-memory-page').error({ error: error }, 'action failed');
      toast({ title: t('files.deleteFailed'), description: messageForUser(assistantPanelFailure(error,t)), tier: 'error' });
    }
  };
  if (renaming)
    return (
      <div className="ta-row" data-divided="">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={() => void commitRename()}
        />
      </div>
    );
  return (
    <AssistantRow
      testId={`assistant-file-${entry.name}`}
      leading={folder ? <Folder className="ta-file-icon" /> : <File className="ta-file-icon" />}
      title={entry.name}
      detail={folder ? undefined : formatSize(entry.size)}
      onClick={folder ? onOpen : undefined}
      trailing={
        <span onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t('common.more')} />}>
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent data-ta-menu="" align="end">
              <DropdownMenuItem onClick={() => setRenaming(true)}>{t('files.rename')}</DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  showConfirm({
                    title: folder ? t('files.deleteFolderTitle') : t('files.deleteFileTitle'),
                    description: folder ? t('files.deleteFolderBody', { name: entry.name }) : t('files.deleteFileBody', { name: entry.name }),
                    confirmLabel: t('common.delete'),
                    variant: 'destructive',
                    onSuccess: () => void remove(),
                  })
                }
              >
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      }
    />
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 文件(「添加与你有关的文件」):云电脑主目录下「给助理的资料」这一夹。人在这里传、建夹、改名、删;
 * 传完一点「让它去看」,把一句交代填进和它的私聊(人看过再发) —— 由人发那一下。
 */
function ResourceFiles({ context, trail }: { context: AssistantContext; trail: string[] }) {
  const { t } = useTranslation('assistant');
  const { toast } = useToast();
  const invalidate = useInvalidateAssistant(context.homeDeviceId);
  const root = context.machine?.paths.resourcesDir ?? null;
  const openFolder = (name: string) => context.go({ tab: 'memory', sub: `files:${[...trail, name].join('/')}` });
  const dir = root ? trail.reduce((acc, name) => joinPath(acc, name), root) : null;
  const listing = useDirectory(context.machine, dir);
  const inputRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const missing = listing.isSuccess && listing.data.length === 0;

  /** 资料夹在第一次用之前不存在:建一下再放东西。 */
  const ensureDir = async () => {
    const machine = context.machine!;
    if (trail.length === 0 && !machine.panel) {
      const cut = machine.paths.resourcesDir.lastIndexOf('/');
      await makeFolder(machine, machine.paths.resourcesDir.slice(0, cut), machine.paths.resourcesDir.slice(cut + 1));
    }
    return dir!;
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !context.machine) return;
    const accepted: File[] = [];
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      const rejected = resourceRejection(file);
      if (rejected) failed.push(`${file.name}: ${rejected === 'too_large' ? t('files.tooLarge') : t('files.unsupported')}`);
      else accepted.push(file);
    }
    if (!accepted.length) { toast({ title: t('files.saveFailed'),description: failed.join('\n'),tier: 'error' }); return; }
    let target: string;
    try { target = await ensureDir(); }
    catch (error) { toast({ title: t('files.saveFailed'),description: messageForUser(assistantPanelFailure(error,t)),tier: 'error' }); return; }
    const done: string[] = [];
    for (const file of accepted) {
      setUploading(file.name);
      try {
        const savedPath = await uploadFile(context.machine, target, file);
        await reportAssistantAppChange(context.machine, context.assistant.id, { resource: 'files', operation: 'saved',
          id: savedPath, deviceId: context.homeDeviceId, after: { name: file.name, path: savedPath } });
        done.push(file.name);
      } catch (cause) {
        failed.push(`${file.name}: ${assistantPanelFailure(cause,t)}`);
      }
    }
    setUploading(null);
    if (failed.length) toast({ title: t('files.saveFailed'),description: failed.join('\n'),tier: 'error' });
    await invalidate('dir');
    if (done.length) {
      setUploaded(done);
      if (!failed.length) toast({ title: t('files.uploaded', { n: done.length }) });
    }
  };

  const createFolder = async () => {
    const problem = folderNameProblem(folderName);
    if (problem) {
      toast({ title: problem === 'required' ? t('files.nameRequired') : t('files.nameSlash'), tier: 'error' });
      return;
    }
    try {
      const target = await ensureDir();
      const savedPath = await makeFolder(context.machine!, target, folderName.trim());
      await reportAssistantAppChange(context.machine, context.assistant.id, { resource: 'files', operation: 'saved',
        id: savedPath, deviceId: context.homeDeviceId, after: { name: folderName.trim(), path: savedPath } });
      setCreating(false);
      setFolderName('');
      await invalidate('dir');
      toast({ title: t('files.folderCreated') });
    } catch (error) { rendererLogger('actions/assistant-memory-page').error({ error: error }, 'action failed');
      toast({ title: t('files.folderCreateFailed'), description: messageForUser(assistantPanelFailure(error,t)), tier: 'error' });
    }
  };

  const where = [RESOURCES_DIR_NAME, ...trail].join('/');
  return (
    <div className="ta-page" data-testid="assistant-files">
      <PageHead
        title={trail.at(-1) ?? RESOURCES_DIR_NAME}
        sub={trail.length ? where : t('files.note', { name: context.assistant.display_name, folder: RESOURCES_DIR_NAME })}
        action={
          context.machine ? (
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" className="ta-circle" aria-label={t('files.newFolder')} title={t('files.newFolder')} onClick={() => setCreating(true)}>
                <FolderPlus />
              </button>
              <button
                type="button"
                className="ta-pill-btn"
                onClick={() => inputRef.current?.click()}
                disabled={!!uploading}
                data-testid="assistant-files-upload"
              >
                <ArrowUpToLine />
                {uploading ? t('files.uploading', { name: uploading }) : t('files.upload')}
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                data-testid="assistant-files-input"
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          ) : null
        }
      />
      <MachineGate
        readiness={context.readiness}
        loading={context.machineLoading || listing.isLoading}
        error={context.machineError ?? listing.error}
        onRetry={() => (context.machineError ? context.retryMachine() : void listing.refetch())}
      >
        {uploaded.length ? (
          <div className="ta-card ta-banner">
            <Sparkles className="ta-banner-icon" />
            <span className="min-w-0 flex-1">{t('files.uploadedBanner', { files: uploaded.join('、') })}</span>
            <button
              type="button"
              className="ta-pill-btn"
              data-testid="assistant-files-analyze"
              onClick={() => {
                context.askInChat(t('files.analyzePrompt', { path: `~/${where}`, files: uploaded.join('、') }));
                setUploaded([]);
              }}
            >
              {t('files.analyze', { name: context.assistant.display_name })}
            </button>
          </div>
        ) : null}
        {creating ? (
          <div className="ta-card flex items-center gap-2">
            <Input
              autoFocus
              value={folderName}
              placeholder={t('files.folderName')}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
                if (e.key === 'Escape') setCreating(false);
              }}
            />
            <button type="button" className="ta-pill-btn" onClick={() => void createFolder()}>
              {t('files.create')}
            </button>
            <button type="button" className="ta-pill-btn" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </div>
        ) : null}
        {missing ? (
          <div className="ta-card">
            <AssistantEmpty>{trail.length ? t('files.folderEmpty') : t('files.empty', { name: context.assistant.display_name })}</AssistantEmpty>
          </div>
        ) : (
          <AssistantSection>
            {(listing.data ?? [])
              .filter((entry) => !entry.name.startsWith('.'))
              .map((entry) => (
                <ResourceRow key={entry.path} entry={entry} context={context} onOpen={() => openFolder(entry.name)} />
              ))}
          </AssistantSection>
        )}
      </MachineGate>
    </div>
  );
}

/** 记忆这一格:首页,或往下钻到的那一页(一条记忆 / 资料夹里某一层 / 语音笔记及其中一条)。 */
export function AssistantMemoryPage({ context }: AssistantPageProps) {
  const sub = context.route.sub ?? '';
  if (sub === 'library:workspace') return <AssistantLibraryVolume key={sub} assistantId={context.assistant.id} machine={context.machine} kind={'workspace'} askInChat={context.askInChat} />;
  if (sub.startsWith('note:')) return <MemoryNoteDetail context={context} file={sub.slice('note:'.length)} />;
  if (sub === VOICE_NOTE_SUB || sub.startsWith(`${VOICE_NOTE_SUB}:`)) return <VoiceNotesPage context={context} />;
  if (sub === 'health') return <AssistantHealthPage context={context} />;
  if (sub === 'files' || sub.startsWith('files:')) {
    const trail = sub.startsWith('files:') ? sub.slice('files:'.length).split('/').filter(Boolean) : [];
    return <ResourceFiles key={sub} context={context} trail={trail} />;
  }
  return <MemoryHome context={context} />;
}
