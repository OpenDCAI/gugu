import { TaskCardHandedTo, TaskStatusMark } from '@/components/chat/ComposerCardView';
import { FileAttachmentCard } from '@/components/chat/FileAttachmentCard';
import { Markdown } from '@/components/markdown/Markdown';
import { IconButton } from '@/components/ui/IconButton';
import { X } from '@/lib/icons';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SampleProjectContent, SampleStep } from './content/types';
import { SAMPLE_AGENT_SEED, sampleFileBytes } from './sample-project-transcript';

/**
 * 点示例里那张任务卡:右边一栏,和群聊里看文件那一栏同宽同头。写的是这一趟真做过的:原话、交给谁、做完了,
 * 它做了哪几步(固化时从那次会话里取的,取不到的就不写),交付了哪些文件(点了看)。
 */
export function SampleTaskPane({ content, onOpenFile, onClose }: { content: SampleProjectContent; onOpenFile: (fileId: string) => void; onClose: () => void }) {
  const { translate, locale } = useSessionMessages();
  const task = content.messages.find((message) => message.kind === 'task');
  const delivered = content.messages.flatMap((message) => (message.kind === 'file' ? [message.file] : []));
  const files = content.files.filter((file) => delivered.includes(file.id));
  const list = new Intl.ListFormat(locale, { type: 'conjunction' });
  const close = translate('projects.sample.closePane');
  return (
    <aside
      data-sample-task-pane=""
      style={{ width: 'clamp(380px, 38vw, 520px)', height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: '1px solid var(--border-subtle)', background: 'var(--bg-primary)' }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 18px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <strong style={{ color: 'var(--text-primary)', fontSize: 'var(--font-title)' }}>{translate('projects.sample.taskDetail')}</strong>
        <IconButton size="md" aria-label={close} title={close} onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-[18px] py-4">
        {task ? <p className="m-0 whitespace-pre-wrap break-words text-[var(--font-prose)] leading-[var(--lh-prose)]">{task.text}</p> : null}
        <TaskCardHandedTo
          agentName={content.agent.name}
          agentAvatar={null}
          agentUserId={SAMPLE_AGENT_SEED}
          note={`· ${translate('projects.sample.taskDone')} · ${content.task.startedAt}–${content.task.endedAt}`}
          mark={<TaskStatusMark status="idle" />}
        />
        {content.task.steps.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-xs font-medium text-[var(--text-tertiary)]">{translate('projects.sample.taskSteps')}</h3>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {content.task.steps.map((step, index) => (
                <li key={index} className="text-[var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">
                  <SampleStepLine step={step} list={list} />
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {files.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-xs font-medium text-[var(--text-tertiary)]">{translate('projects.sample.taskFiles')}</h3>
            {files.map((file) => (
              <FileAttachmentCard key={file.id} file={{ fileName: file.name, sizeBytes: sampleFileBytes(file), mimeType: file.mimeType }} onOpen={() => onOpenFile(file.id)} />
            ))}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function SampleStepLine({ step, list }: { step: SampleStep; list: Intl.ListFormat }) {
  const { translate } = useSessionMessages();
  switch (step.kind) {
    case 'said':
      return <Markdown trust="chat" content={step.text} />;
    case 'searched':
      return (
        <>
          {translate('projects.sample.searched')}
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-[var(--text-tertiary)]">
            {step.queries.map((query) => <li key={query} className="truncate" title={query}>{query}</li>)}
          </ul>
        </>
      );
    case 'wrote':
      return <>{translate('projects.sample.wrote', { files: list.format(step.files) })}</>;
    case 'shared':
      return <>{translate('projects.sample.shared', { files: list.format(step.files) })}</>;
    case 'posted':
      return <>{translate('projects.sample.posted')}</>;
  }
}
