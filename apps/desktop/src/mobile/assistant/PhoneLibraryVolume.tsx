import { useTranslation } from 'react-i18next'
import { AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume'
import { PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineView } from './PhoneMachineView'

/** Cloud file books remain available independently of the execution device. */
export function PhoneLibraryVolume({ kind, machine, assistant, askInChat }: Pick<PhonePageProps, 'machine' | 'assistant' | 'askInChat'> & {
  kind: 'capabilities' | 'devices' | 'workspace'
}) {
  const { t } = useTranslation('assistant')
  const ready = machine.state === 'ready' ? machine.machine : null
  if (kind === 'workspace' || ready) return <AssistantLibraryVolume assistantId={assistant.id} machine={ready} kind={kind} askInChat={askInChat} />
  return <div className="ta-page" data-testid="phone-library-unavailable">
    <PageHead title={t(`library.${kind}`)} />
    <PhoneMachineView machine={machine} name={assistant.display_name}>{() => null}</PhoneMachineView>
  </div>
}
