import { useTranslation } from 'react-i18next'
import { AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume'
import { PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineView } from './PhoneMachineView'

/** File books need the assistant's real workspace; the project index uses the account directory. */
export function PhoneLibraryVolume({ kind, machine, readiness, assistant, askInChat }: Pick<PhonePageProps, 'machine' | 'readiness' | 'assistant' | 'askInChat'> & {
  kind: 'capabilities' | 'devices' | 'workspace'
}) {
  const { t } = useTranslation('assistant')
  const ready = readiness === 'ready' && machine.state === 'ready' ? machine.machine : null
  if (kind === 'workspace' || ready) return <AssistantLibraryVolume machine={ready} kind={kind} askInChat={askInChat} />
  return <div className="ta-page" data-testid="phone-library-unavailable">
    <PageHead title={t(`library.${kind}`)} />
    <PhoneMachineView readiness={readiness} machine={machine} name={assistant.display_name}>{() => null}</PhoneMachineView>
  </div>
}
