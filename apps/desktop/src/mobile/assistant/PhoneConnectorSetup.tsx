import { rendererLogger } from '@/lib/log';
import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
import type { IntegrationCredentials } from '@gugu/session-plugins/integrations'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'
import { Check, Copy, ExternalLink, Eye, EyeOff } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { platform } from '@/platform'
import { openAuthorizationLink } from '@/lib/openAuthorizationLink'
import { CliInstallProgress } from '@/session/renderer/features/integrations/CliInstallProgress'
import { AssistantEmpty, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { integrationErrorText } from '@/session/renderer/features/integrations/integration-display'
import {
  canSubmitForm,
  cliMethodOf,
  formInputOf,
  formMethodOf,
  initialFormValues,
} from '@/session/renderer/features/integrations/integration-setup-model'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { githubAuthDeviceCodeChannel } from '@/session/shared/events/githubEvents'
import { machineRpc, onMachineEvent } from '../agent-watch/sessionpage-rpc'
import type { PhonePageProps } from './MobileAssistantApp'
import { CloudGate, ConnectorIcon } from './PhoneConnectors'
import { createNativeFetch } from './phoneNativeFetch'
import {
  connectWithInput,
  failureKey,
  randomOauthAttempt,
  setupPlanOf,
  startCliSetup,
  startGithubSetup,
  startOauthSetup,
  type CliPrompt,
  type CliSetupState,
  type GithubSetupState,
  type OauthSetupDeps,
  type OauthSetupHandle,
  type OauthState,
  type SetupFailure,
} from './phoneConnectorFlow'
import { connectorDetail } from './phoneProfileModel'
import type { usePhoneIntegrations } from './usePhoneProfileData'

type Integrations = ReturnType<typeof usePhoneIntegrations>
type MachineRpc = ReturnType<typeof machineRpc>

/** Copy the authorization text; surface a refused clipboard write. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    rendererLogger('actions/PhoneConnectorSetup').error({ error: error }, 'action failed')
    toast({ title: translateSessionMessage('task.copyFailed'), description: messageForUser(error), tier: 'error' })
    return false
  }
}

const AuthorizationBrowser = createContext<(url: string) => void>(() => {})

/**
 * 连接页(手机):按这一家的连接方式换不同的一页,同一个入口、同一个「连接」钮。
 *  · 表单   —— 填授权码 / API key,保存并连接。
 *  · 浏览器 —— 系统浏览器同意授权,把回跳的网址贴回来(桌面的回跳监听在手机上没有,见 phoneConnectorFlow.ts 的说明)。
 *  · 命令行 —— 助理那边装好工具并登录,手机上看授权链接 / 二维码。
 *  · GitHub —— 设备码。
 * 需要连接助理的家时由读取门处理；每一条登录路径只在人点了「连接」之后才发请求。
 */
export function PhoneConnectorSetupPage({
  assistant,
  readiness,
  homeDeviceId,
  integrations,
  id,
  go,
}: PhonePageProps & { integrations: Integrations; id: string }) {
  const { t } = useTranslation('assistant')
  const name = assistant.display_name
  const view = integrations.data && !integrations.error ? connectorDetail(integrations.data.items, integrations.data.configured, integrations.data.statuses, id) : null
  const rpc = useMemo(() => (homeDeviceId ? machineRpc(homeDeviceId) : null), [homeDeviceId])
  const [done, setDone] = useState<{ displayName?: string } | null>(null)
  const [browserFailed, setBrowserFailed] = useState<string | null>(null)
  const openInBrowser = useCallback((url: string) => {
    setBrowserFailed(null)
    void openAuthorizationLink(url).catch((error) => setBrowserFailed(messageForUser(error)))
  }, [])
  const connected = (displayName?: string) => {
    if (rpc) void reportAssistantAppChange({ rpc }, assistant.id, { resource: 'integrations', operation: 'saved', id,
      deviceId: homeDeviceId ?? undefined, after: { name: view?.item.name ?? id } })
    // 连上了:重读一遍连接状态,回详情页时已是「已连接 + 账号」。
    integrations.retry()
    setDone({ ...(displayName ? { displayName } : {}) })
  }
  return (
    <AuthorizationBrowser.Provider value={openInBrowser}>
    <div className="ta-page ta-phone-profile" data-testid="assistant-connector-setup">
      <PageHead title={view ? t('connectors.setup.title', { name: view.item.name }) : t('connectors.title')} />
      {browserFailed ? <p role="alert" className="ta-phone-error">{t('connectors.setup.openFailed')}<br />{browserFailed}</p> : null}
      <CloudGate readiness={readiness} name={name} integrations={integrations}>
        {() =>
          !view || !rpc ? (
            <AssistantEmpty title={t('connectors.goneTitle')}>{t('connectors.gone')}</AssistantEmpty>
          ) : done ? (
            <SetupDone item={view.item} displayName={done.displayName} finish={() => go(`connector:${view.item.id}`)} />
          ) : (
            <SetupBody item={view.item} rpc={rpc} deviceId={homeDeviceId ?? ''} assistantName={name} onConnected={connected} />
          )
        }
      </CloudGate>
    </div>
    </AuthorizationBrowser.Provider>
  )
}

function SetupBody({
  item,
  rpc,
  deviceId,
  assistantName,
  onConnected,
}: {
  item: IntegrationMetadata
  rpc: MachineRpc
  deviceId: string
  assistantName: string
  onConnected: (displayName?: string) => void
}) {
  const { t } = useTranslation('assistant')
  const plan = setupPlanOf(item, platform.kind)
  if (plan.kind === 'form') return <FormSetup item={item} rpc={rpc} onConnected={onConnected} />
  if (plan.kind === 'browser') return <BrowserSetup item={item} serverUrl={plan.serverUrl} rpc={rpc} onConnected={onConnected} />
  if (plan.kind === 'cli') return <CliSetup item={item} rpc={rpc} assistantName={assistantName} onConnected={onConnected} />
  if (plan.kind === 'github') return <GithubSetup item={item} rpc={rpc} deviceId={deviceId} onConnected={onConnected} />
  return (
    <div data-testid="assistant-connector-unavailable">
      <AssistantEmpty>{plan.reason === 'needs-app' ? t('connectors.connectInApp', { name: item.name }) : t('connectors.connectOnDesktop')}</AssistantEmpty>
    </div>
  )
}

function SetupDone({ item, displayName, finish }: { item: IntegrationMetadata; displayName: string | undefined; finish: () => void }) {
  const { t } = useTranslation('assistant')
  return (
    <div className="ta-phone-setup" data-testid="assistant-connector-done">
      <div className="ta-card ta-connector-hero">
        <ConnectorIcon integration={item} size={56} />
        <span className="ta-tile-title">{t('connectors.setup.doneTitle', { name: item.name })}</span>
        {displayName ? <span className="ta-page-sub">{t('connectors.setup.doneAccount', { account: displayName })}</span> : null}
      </div>
      <Button variant="ghost" className="ta-wide-btn" data-tone="primary" onClick={finish} data-testid="assistant-connector-done-finish">
        <Check />
        {t('connectors.setup.finish')}
      </Button>
    </div>
  )
}

/** 失败那一格:先说哪一步没成(那一家分好类的错按界面语言说),对方 / 工具自己的话作小字补在后面,最后给「重试」。 */
function SetupFailureNote({ failure, name, assistantName, onRetry }: { failure: SetupFailure; name: string; assistantName: string; onRetry: () => void }) {
  const { t } = useTranslation('assistant')
  const typed = failure.errorType && failure.errorType !== 'generic' ? integrationErrorText(translateSessionMessage, name, { errorType: failure.errorType }) : undefined
  return (
    <div className="ta-phone-setup-fail" role="alert" data-testid="assistant-connector-failure" data-step={failure.step} data-reason={failure.reason}>
      <p className="ta-phone-error">{typed ?? t(`connectors.setup.${failureKey(failure)}`, { name, assistant: assistantName })}</p>
      {!typed && failure.detail ? <p className="ta-phone-setup-detail">{failure.detail}</p> : null}
      <Button variant="ghost" className="ta-pill-btn" onClick={onRetry} data-testid="assistant-connector-retry">
        {t('machine.retry')}
      </Button>
    </div>
  )
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="ta-phone-setup-wait" role="status">
      <LoadingIndicator size="inline" />
      <span>{children}</span>
    </div>
  )
}

// ── 表单 ────────────────────────────────────────────────────────────────

function FormSetup({ item, rpc, onConnected }: { item: IntegrationMetadata; rpc: MachineRpc; onConnected: (displayName?: string) => void }) {
  const { t } = useTranslation('assistant')
  const openInBrowser = useContext(AuthorizationBrowser)
  const method = formMethodOf(item)
  const [values, setValues] = useState<Record<string, string>>(() => initialFormValues(method?.fields ?? []))
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<SetupFailure | null>(null)
  if (!method) return null
  const secretLabel = method.fields.find((field) => field.secret)?.label

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    const result = await connectWithInput(
      (input) => rpc.integrations.connect(item.id, input as IntegrationCredentials),
      formInputOf(method.fields, values),
    )
    setBusy(false)
    if (result.ok) onConnected(result.displayName)
    else setFailure(result.failure)
  }
  const toggleReveal = (fieldId: string) =>
    setRevealed((current) => {
      const next = new Set(current)
      if (next.has(fieldId)) next.delete(fieldId)
      else next.add(fieldId)
      return next
    })

  return (
    <form
      className="ta-phone-setup"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmitForm(method.fields, values, false) && !busy) void submit()
      }}
      data-testid="assistant-connector-form"
    >
      <p className="ta-page-sub ta-pad">{t('connectors.setup.formIntro', { name: item.name })}</p>
      {method.fields.map((field) => {
        const shown = revealed.has(field.id)
        return (
          <label key={field.id} className="flex flex-col gap-2">
            <span className="ta-field-label">
              {field.label}
              {field.required ? ' *' : ''}
            </span>
            <span className="ta-phone-setup-field">
              <input
                className="ta-input"
                type={field.secret && !shown ? 'password' : 'text'}
                value={values[field.id] ?? ''}
                placeholder={field.placeholder ?? field.label}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                disabled={busy}
                data-testid={`assistant-connector-field-${field.id}`}
              />
              {field.secret ? (
                <Button
                  variant="ghost"
                  className="ta-phone-setup-reveal"
                  onClick={() => toggleReveal(field.id)}
                  aria-label={shown ? t('connectors.setup.hide') : t('connectors.setup.show')}
                  aria-pressed={shown}
                >
                  {shown ? <EyeOff /> : <Eye />}
                </Button>
              ) : null}
            </span>
          </label>
        )
      })}
      {method.help ? <p className="ta-page-sub ta-pad">{method.help}</p> : null}
      {method.helpUrl ? (
        <Button variant="ghost" className="ta-pill-btn" onClick={() => openInBrowser(method.helpUrl ?? '')} data-testid="assistant-connector-guide">
          <ExternalLink />
          {secretLabel ? t('connectors.setup.guide', { label: secretLabel }) : t('connectors.setup.guideDefault', { name: item.name })}
        </Button>
      ) : null}
      {failure ? <SetupFailureNote failure={failure} name={item.name} assistantName="" onRetry={() => void submit()} /> : null}
      <Button
        variant="ghost"
        type="submit"
        className="ta-wide-btn"
        data-tone="primary"
        disabled={busy || !canSubmitForm(method.fields, values, false)}
        data-testid="assistant-connector-submit"
      >
        {busy ? t('connectors.setup.verifying') : t('connectors.setup.submit')}
      </Button>
    </form>
  )
}

// ── 浏览器授权 ───────────────────────────────────────────────────────────

function BrowserSetup({
  item,
  serverUrl,
  rpc,
  onConnected,
}: {
  item: IntegrationMetadata
  serverUrl: string
  rpc: MachineRpc
  onConnected: (displayName?: string) => void
}) {
  const { t } = useTranslation('assistant')
  const openInBrowser = useContext(AuthorizationBrowser)
  const [state, setState] = useState<OauthState | null>(null)
  const [text, setText] = useState('')
  const [pasteFailed, setPasteFailed] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const handle = useRef<OauthSetupHandle | null>(null)
  const connectedRef = useRef(onConnected)
  connectedRef.current = onConnected
  // 离开这一页 = 放弃这次授权:撤掉等待(晚到的回跳不会再被收下)。
  useEffect(() => () => handle.current?.cancel(), [])

  const start = () => {
    handle.current?.cancel()
    setText('')
    setPasteFailed(null)
    const deps: OauthSetupDeps = {
      begin: async (options) => {
        // OAuth 客户端(MCP SDK 的授权那一块)只在人点「前往授权」时才加载。
        const { beginMcpAuthorization } = await import('@/session/shared/mcp-oauth-client')
        return beginMcpAuthorization({ ...options, ...(platform.kind === 'capacitor' ? { fetchFn: createNativeFetch() } : {}) })
      },
      openUrl: openInBrowser,
      connect: (credentials) => rpc.integrations.connect(item.id, credentials as IntegrationCredentials),
      newAttempt: () => randomOauthAttempt(),
    }
    handle.current = startOauthSetup(deps, { serverUrl }, (next) => {
      setState(next)
      if (next.phase === 'done') connectedRef.current(next.displayName)
    })
  }

  const submit = (value: string) => handle.current?.submit(value)
  const onChange = (value: string) => {
    setText(value)
    // 贴进来的就是回跳(带授权结果):不必再点一下。
    if (/(?:^|[?&])(?:code|error)=/.test(value)) submit(value)
  }
  const paste = async () => {
    try {
      const value = await navigator.clipboard.readText()
      setPasteFailed(null)
      onChange(value)
    } catch (error) {
      setPasteFailed(messageForUser(error))
    }
  }

  if (!state || state.phase === 'cancelled') {
    return (
      <div className="ta-phone-setup" data-testid="assistant-connector-browser">
        <p className="ta-page-sub ta-pad">{t('connectors.setup.browserIntro', { name: item.name })}</p>
        <Button variant="ghost" className="ta-wide-btn" data-tone="primary" onClick={start} data-testid="assistant-connector-authorize">
          <ExternalLink />
          {t('connectors.setup.authorize')}
        </Button>
      </div>
    )
  }
  if (state.phase === 'failed') {
    return (
      <div className="ta-phone-setup" data-testid="assistant-connector-browser">
        <SetupFailureNote failure={state.failure} name={item.name} assistantName="" onRetry={start} />
      </div>
    )
  }
  if (state.phase === 'preparing') {
    return (
      <div className="ta-phone-setup" data-testid="assistant-connector-browser">
        <Waiting>{t('connectors.setup.preparing', { name: item.name })}</Waiting>
        <Button variant="ghost" className="ta-pill-btn" onClick={() => handle.current?.cancel()} data-testid="assistant-connector-cancel">
          {t('common.cancel')}
        </Button>
      </div>
    )
  }
  if (state.phase === 'finishing' || state.phase === 'done') {
    return (
      <div className="ta-phone-setup" data-testid="assistant-connector-browser">
        <Waiting>{t('connectors.setup.finishing', { name: item.name })}</Waiting>
      </div>
    )
  }
  return (
    <div className="ta-phone-setup" data-testid="assistant-connector-browser" data-phase="awaiting">
      <ol className="ta-phone-setup-steps">
        <li>{t('connectors.setup.step1', { name: item.name })}</li>
        <li>{t('connectors.setup.step2')}</li>
        <li>{t('connectors.setup.step3')}</li>
      </ol>
      <p className="ta-page-sub ta-pad">{t('connectors.setup.appInterceptHint', { name: item.name })}</p>
      <textarea
        className="ta-input"
        value={text}
        placeholder={t('connectors.setup.pasteHere')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        data-testid="assistant-connector-paste"
      />
      {state.hint || pasteFailed ? (
        <p className="ta-phone-error" role="alert" data-testid="assistant-connector-paste-hint">
          {pasteFailed ? <>{t('connectors.setup.pasteFailed')}<br />{pasteFailed}</> : t(`connectors.setup.hint.${state.hint}`)}
        </p>
      ) : null}
      <div className="ta-phone-setup-actions">
        <Button variant="ghost" className="ta-wide-btn" data-tone="primary" onClick={() => void paste()} data-testid="assistant-connector-paste-button">
          <Copy />
          {t('connectors.setup.paste')}
        </Button>
        <Button variant="ghost" className="ta-wide-btn" disabled={!text.trim()} onClick={() => submit(text)} data-testid="assistant-connector-paste-submit">
          {t('connectors.setup.submitReturn')}
        </Button>
        <Button variant="ghost" className="ta-pill-btn" onClick={() => handle.current?.reopen()} data-testid="assistant-connector-reopen">
          <ExternalLink />
          {t('connectors.setup.reopen')}
        </Button>
        <Button
          variant="ghost"
          className="ta-pill-btn"
          onClick={() => {
            void copyText(state.authorizationUrl).then((copied) => {
              setLinkCopied(copied)
              window.setTimeout(() => setLinkCopied(false), 1500)
            })
          }}
          data-testid="assistant-connector-copy-auth-link"
        >
          {linkCopied ? <Check /> : <Copy />}
          {linkCopied ? t('connectors.setup.linkCopied') : t('connectors.setup.copyAuthLink')}
        </Button>
        <Button variant="ghost" className="ta-pill-btn" onClick={() => handle.current?.cancel()} data-testid="assistant-connector-cancel">
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}

// ── 官方命令行 ───────────────────────────────────────────────────────────

function CliSetup({
  item,
  rpc,
  assistantName,
  onConnected,
}: {
  item: IntegrationMetadata
  rpc: MachineRpc
  assistantName: string
  onConnected: (displayName?: string) => void
}) {
  const { t } = useTranslation('assistant')
  const openInBrowser = useContext(AuthorizationBrowser)
  const method = cliMethodOf(item)
  const [state, setState] = useState<CliSetupState | null>(null)
  const readProgress = useCallback(() => rpc.integrations.cliLoginProgress(item.id), [rpc, item.id])
  const handle = useRef<{ cancel(): void } | null>(null)
  const connectedRef = useRef(onConnected)
  connectedRef.current = onConnected
  useEffect(() => () => handle.current?.cancel(), [])

  const start = () => {
    handle.current?.cancel()
    handle.current = startCliSetup(
      {
        start: () => rpc.integrations.cliLoginStart(item.id),
        wait: () => rpc.integrations.cliLoginWait(item.id),
        cancel: () => rpc.integrations.cancelAuthorization(item.id),
      },
      (next) => {
        setState(next)
        if (next.phase === 'done') connectedRef.current()
      },
    )
  }
  const idle = !state || state.phase === 'cancelled'
  return (
    <div className="ta-phone-setup" data-testid="assistant-connector-cli">
      {idle ? (
        <>
          <p className="ta-page-sub ta-pad">{t('connectors.setup.cliIntro', { name: item.name, assistant: assistantName })}</p>
          {method?.prerequisite ? (
            <div className="ta-card ta-phone-setup-prereq" data-testid="assistant-connector-prereq">
              <p className="ta-page-sub">{method.prerequisite.text}</p>
              {method.prerequisite.url ? (
                <Button variant="ghost" className="ta-pill-btn" onClick={() => openInBrowser(method.prerequisite?.url ?? '')}>
                  <ExternalLink />
                  {t('connectors.setup.prerequisiteLink')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Button variant="ghost" className="ta-wide-btn" data-tone="primary" onClick={start} data-testid="assistant-connector-cli-start">
            {t('connectors.connect')}
          </Button>
        </>
      ) : state.phase === 'starting' ? (
        <>
          <Waiting>{t('connectors.setup.cliPreparing', { name: item.name })}</Waiting>
          <CliInstallProgress read={readProgress} />
          <Button variant="ghost" className="ta-pill-btn" onClick={() => handle.current?.cancel()} data-testid="assistant-connector-cancel">
            {t('common.cancel')}
          </Button>
        </>
      ) : state.phase === 'waiting' ? (
        <>
          <CliPromptView prompt={state.prompt} name={item.name} />
          <Waiting>{t('connectors.setup.cliWaiting')}</Waiting>
          <Button variant="ghost" className="ta-pill-btn" onClick={() => handle.current?.cancel()} data-testid="assistant-connector-cancel">
            {t('common.cancel')}
          </Button>
        </>
      ) : state.phase === 'failed' ? (
        <SetupFailureNote failure={state.failure} name={item.name} assistantName={assistantName} onRetry={start} />
      ) : null}
    </div>
  )
}

function CliPromptView({ prompt, name }: { prompt: CliPrompt; name: string }) {
  const { t } = useTranslation('assistant')
  const openInBrowser = useContext(AuthorizationBrowser)
  const [copied, setCopied] = useState(false)
  const link = prompt.url
  const copyLink = async () => {
    if (!link) return
    setCopied(await copyText(link))
    window.setTimeout(() => setCopied(false), 1500)
  }
  const linkActions = link ? (
    <div className="ta-phone-setup-actions">
      <Button variant="ghost" className="ta-wide-btn" data-tone="primary" onClick={() => openInBrowser(link)} data-testid="assistant-connector-open-link">
        <ExternalLink />
        {t('connectors.setup.cliOpenAuthorize', { name })}
      </Button>
      <Button variant="ghost" className="ta-pill-btn" onClick={() => void copyLink()}>
        {copied ? <Check /> : <Copy />}
        {copied ? t('connectors.setup.linkCopied') : t('connectors.setup.copyLink')}
      </Button>
    </div>
  ) : null
  if (prompt.kind === 'device-link') {
    return (
      <div className="ta-phone-setup" data-testid="assistant-connector-device-link">
        <p className="ta-page-sub ta-pad">{t(prompt.code ? 'connectors.setup.cliDeviceHint' : 'connectors.setup.cliWaiting', { name })}</p>
        {prompt.code ? <div className="ta-phone-setup-code" data-testid="assistant-connector-code" aria-label={t('connectors.setup.cliCode')}>
          {prompt.code}
        </div> : null}
        {linkActions}
      </div>
    )
  }
  return (
    <div className="ta-phone-setup" data-testid="assistant-connector-qr">
      <img className="ta-phone-setup-qr" src={prompt.image} alt={t('connectors.setup.cliQrAlt', { name })} />
      <p className="ta-page-sub ta-pad">{link ? t('connectors.setup.cliQrHintLink', { name }) : t('connectors.setup.cliQrHint', { name })}</p>
      {linkActions}
    </div>
  )
}

// ── GitHub 设备码 ────────────────────────────────────────────────────────

function GithubSetup({
  item,
  rpc,
  deviceId,
  onConnected,
}: {
  item: IntegrationMetadata
  rpc: MachineRpc
  deviceId: string
  onConnected: (displayName?: string) => void
}) {
  const { t } = useTranslation('assistant')
  const openInBrowser = useContext(AuthorizationBrowser)
  const [state, setState] = useState<GithubSetupState | null>(null)
  const [copied, setCopied] = useState(false)
  const handle = useRef<{ cancel(): void } | null>(null)
  const connectedRef = useRef(onConnected)
  connectedRef.current = onConnected
  useEffect(() => () => handle.current?.cancel(), [])

  const start = () => {
    handle.current?.cancel()
    setCopied(false)
    handle.current = startGithubSetup(
      {
        onCode: (listener) => onMachineEvent(deviceId, githubAuthDeviceCodeChannel, listener),
        auth: () => rpc.github.auth(),
        cancel: () => rpc.github.authCancel(),
      },
      (next) => {
        setState(next)
        if (next.phase === 'done') connectedRef.current(`@${next.login}`)
      },
    )
  }
  const idle = !state || state.phase === 'cancelled'
  return (
    <div className="ta-phone-setup" data-testid="assistant-connector-github">
      {idle ? (
        <>
          <p className="ta-page-sub ta-pad">{t('connectors.setup.githubIntro')}</p>
          <Button variant="ghost" className="ta-wide-btn" data-tone="primary" onClick={start} data-testid="assistant-connector-github-start">
            {t('connectors.setup.githubStart')}
          </Button>
        </>
      ) : state.phase === 'starting' ? (
        <>
          <Waiting>{t('connectors.setup.githubStarting')}</Waiting>
          <Button variant="ghost" className="ta-pill-btn" onClick={() => handle.current?.cancel()} data-testid="assistant-connector-cancel">
            {t('common.cancel')}
          </Button>
        </>
      ) : state.phase === 'code' ? (
        <>
          <p className="ta-page-sub ta-pad">{t('connectors.setup.githubCodeHint')}</p>
          <div className="ta-phone-setup-code" data-testid="assistant-connector-code">
            {state.code.userCode}
          </div>
          <div className="ta-phone-setup-actions">
            <Button
              variant="ghost"
              className="ta-wide-btn"
              data-tone="primary"
              onClick={() => {
                const { userCode, verificationUri } = state.code
                void copyText(userCode).then(setCopied)
                openInBrowser(verificationUri)
              }}
              data-testid="assistant-connector-github-open"
            >
              {copied ? <Check /> : <ExternalLink />}
              {t('connectors.setup.githubCopyOpen')}
            </Button>
          </div>
          <Waiting>{t('connectors.setup.githubWaiting')}</Waiting>
          <Button variant="ghost" className="ta-pill-btn" onClick={() => handle.current?.cancel()} data-testid="assistant-connector-cancel">
            {t('common.cancel')}
          </Button>
        </>
      ) : state.phase === 'failed' ? (
        <SetupFailureNote failure={state.failure} name={item.name} assistantName="" onRetry={start} />
      ) : null}
    </div>
  )
}
