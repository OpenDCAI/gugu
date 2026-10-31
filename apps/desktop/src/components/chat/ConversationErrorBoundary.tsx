import { Component, Fragment, type ErrorInfo, type PropsWithChildren } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { rendererLogger } from '@/lib/log'

const log = rendererLogger('chat/conversation-boundary')

function FailedConversation({ retry }: { retry: () => void }) {
  const { t } = useTranslation('main')
  return <div role="alert" data-testid="conversation-error-fallback" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
    <p>{t('errorBoundary.shell.title')}</p>
    <Button onClick={retry}>{t('errorBoundary.shell.retry')}</Button>
  </div>
}

/** A failed conversation leaves the shell's navigation and other conversations mounted. */
class ConversationErrorBoundaryImpl extends Component<PropsWithChildren, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error({ error, componentStack: info.componentStack }, 'conversation render failed')
  }
  render() {
    if (this.state.failed) return <FailedConversation retry={() => this.setState(state => ({ failed: false, attempt: state.attempt + 1 }))} />
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}

export function ConversationErrorBoundary({ children }: PropsWithChildren) {
  return <ConversationErrorBoundaryImpl>{children}</ConversationErrorBoundaryImpl>
}
