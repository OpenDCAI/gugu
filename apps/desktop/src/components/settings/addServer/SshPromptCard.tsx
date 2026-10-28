import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Server } from '@/lib/icons'
import type { ServerSshInstallPrompt } from '../../../lib/serverSshInstall'
import { cn } from '../../../lib/cn'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { IconButton } from '../../ui/IconButton'
import { calloutClassName } from './callout'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

// #6264 SSH 在问的一个问题,就地问人(behavior「要密码或密钥口令时在咕咕里问,❌ 卡住不动」)。
// 照 Zed 的做法:新主机把指纹拆开摆清楚再问 是/否;密码与口令给「显示/隐藏」与大写锁定提示;
// 服务器自己的提问(二次验证码、键盘交互)原话照摆;只要人去碰一下安全密钥的,只提示、不要输入。
//
// 同一张卡片,两种摆法(variant):
// - inline:长在「添加一台机器」那一块、卸载确认页里 —— callout(一条色线 + 密度底,见 ./callout),
//   上下文(装到哪台机器)页面上已经写着,卡片里 ❌ 再说一遍;
// - floating:浮在远端终端 / 远端浏览器上 —— 照 Zed 的 RemoteConnectionModal
//   (zed-industries/zed crates/remote_connection/src/remote_connection.rs):
//   顶上一行「哪台机器」,中间一条输入带,底下一行状态 + 按钮;形状与咕咕的命令面板同一套
//   (浮层 --radius-xl + 唯一那档 lift,分段只靠 hairline)。浮层上 ❌ 墨色粗竖线、❌ 卡片外另挂一颗说明胶囊。
// 标题前 ❌ 摆钥匙 / 盾牌图标 —— 标题那句话已经说清在问什么。

const text = 'text-[length:var(--font-body)] leading-[1.5]'
const caption = 'text-[length:var(--font-caption)] leading-[1.5]'

export type SshPromptVariant = 'inline' | 'floating'

/** floating 卡片顶上那一行:哪台机器(`name`)+ 在连什么(`detail`,如 `alice@box:22`、「转发 3000 端口」)。 */
export type SshPromptContext = { name: string; detail?: string | null }

export function SshPromptCard(props: {
  prompt: ServerSshInstallPrompt
  /** installKey:密码下面那个「以后连这台机器不用再输密码」勾上了(只在 prompt.offerKeyInstall 时出)。 */
  onAnswer: (value: string | null, extra?: { installKey?: boolean }) => void
  /**
   * 卡片自己带一颗「取消」(= onAnswer(null),floating 上 Esc 同义)。添加机器 / 卸载底下已经有一颗
   * 停掉整件事的「取消」,不带;直连终端、远端浏览器上的这张卡片没有别的出口,带上。
   */
  cancellable?: boolean
  variant?: SshPromptVariant
  context?: SshPromptContext | null
  /**
   * 已经答过、ssh 正在拿这个回答去连(调用处知道得比卡片久:直连终端答完后提问会先收起,
   * 连接还要一会儿)。卡片据此停在「正在连接…」,输入与按钮都不可再点。
   */
  pending?: boolean
}) {
  // 换了一个问题(新 id)= 一张新卡片:输入、显示/隐藏、「已提交」都从头来。
  // 调用处有的没给 key(卸载页),所以在这里按 id 重挂,❌ 指望每个调用处都记得。
  // 「以后不用再输密码」那个勾例外:密码输错、再问一遍时它还是人上次勾的样子(Tabby 的 Remember 也跟着同一个框走)。
  const [installKey, setInstallKey] = useState(false)
  return <SshPromptBody key={props.prompt.id} {...props} installKey={installKey} onInstallKeyChange={setInstallKey} />
}

function SshPromptBody({
  prompt,
  onAnswer,
  cancellable = false,
  variant = 'inline',
  context = null,
  pending = false,
  installKey,
  onInstallKeyChange,
}: Parameters<typeof SshPromptCard>[0] & { installKey: boolean; onInstallKeyChange: (value: boolean) => void }) {
  const { t } = useTranslation('settings')
  const [value, setValue] = useState('')
  // 验证码默认看得见(输错一位要能看出来);密码、口令默认遮住。
  const [visible, setVisible] = useState(prompt.kind === 'otp')
  const [capsLock, setCapsLock] = useState(false)
  // 点了「继续」到这张卡片被收起之间(一趟 IPC,或调用处给的 pending):❌ 让人以为没点上再点一次。
  const [sent, setSent] = useState(false)
  const busy = pending || sent
  const floating = variant === 'floating'
  // #6264「下次免密」:只在登录密码提问上、且这条连接登上之后能替人装钥匙时出(口令 / 验证码 / 指纹 ❌)。
  const offerKey = prompt.kind === 'password' && prompt.offerKeyInstall === true

  const answer = (next: string | null) => {
    if (busy) return
    if (next !== null) setSent(true)
    if (next !== null && offerKey) onAnswer(next, { installKey })
    else onAnswer(next)
  }
  const trackCaps = (event: KeyboardEvent<HTMLInputElement>) => {
    if (typeof event.getModifierState === 'function') setCapsLock(event.getModifierState('CapsLock'))
  }
  // Zed / VS Code 的连接提问:Esc = 取消。只在卡片自己带「取消」时生效(添加机器的取消是停掉整次安装,另有一颗钮)。
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !cancellable || busy) return
    event.preventDefault()
    event.stopPropagation()
    answer(null)
  }

  const cancelButton = cancellable && !busy && (
    <Button size="sm" onClick={() => answer(null)} data-testid="ssh-prompt-cancel">{t('devices.addServer.prompt.cancel')}</Button>
  )
  const connecting = busy && (
    <span className="flex min-w-0 items-center gap-2" role="status" data-testid="ssh-prompt-pending">
      <LoadingIndicator size="inline" />
      <span className="truncate">{t('devices.addServer.prompt.connecting')}</span>
    </span>
  )

  if (prompt.kind === 'hostKey') {
    const key = prompt.hostKey
    const spec = key ? (
      <dl className={cn(caption, 'm-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1')}>
        {key.host && (
          <>
            <dt className="text-[var(--faint-fg)]">{t('devices.addServer.prompt.host')}</dt>
            <dd className="m-0 break-all font-mono text-[var(--fg)]">{key.host}</dd>
          </>
        )}
        {key.keyType && (
          <>
            <dt className="text-[var(--faint-fg)]">{t('devices.addServer.prompt.keyType')}</dt>
            <dd className="m-0 font-mono text-[var(--fg)]">{key.keyType}</dd>
          </>
        )}
        <dt className="text-[var(--faint-fg)]">{t('devices.addServer.prompt.fingerprint')}</dt>
        <dd className="m-0 select-all break-all font-mono text-[var(--fg)]" data-testid="add-server-fingerprint">{key.fingerprint}</dd>
      </dl>
    ) : (
      <pre className={cn(caption, 'm-0 whitespace-pre-wrap break-all font-mono text-[var(--muted-fg)]')}>{prompt.message}</pre>
    )
    const buttons = !busy && (
      <>
        <Button size="sm" onClick={() => answer(null)}>{t('devices.addServer.prompt.rejectHost')}</Button>
        <Button size="sm" variant="primary" autoFocus onClick={() => answer('yes')}>{t('devices.addServer.prompt.trustHost')}</Button>
      </>
    )
    const title = <div className={cn(text, 'font-semibold text-[var(--fg)]')}>{t('devices.addServer.prompt.hostKeyTitle')}</div>
    const hint = <div className={cn(caption, 'text-[var(--muted-fg)]')}>{t('devices.addServer.prompt.hostKeyHint')}</div>
    if (floating) {
      return (
        <SshPromptFrame context={context} testId="add-server-prompt-hostkey" onKeyDown={onEscape} status={connecting} actions={buttons}>
          {title}
          {hint}
          {/* 规格表垫一层密度底:浮层是一张纸,指纹是印在纸上的一块(--radius-document)。 */}
          <div className="rounded-[var(--radius-document)] bg-foreground/[0.025] px-3 py-2 dark:bg-foreground/[0.04]">{spec}</div>
        </SshPromptFrame>
      )
    }
    return (
      <div className={calloutClassName('ask')} data-testid="add-server-prompt-hostkey">
        {title}
        {hint}
        {/* 已经在 callout 的密度底上了:规格表直接排,❌ 再垫一层 muted 实底(面里套面)。 */}
        {spec}
        <div className="flex items-center justify-end gap-2">{connecting || buttons}</div>
      </div>
    )
  }

  if (prompt.kind === 'notice') {
    const title = <div className={cn(text, 'font-semibold text-[var(--fg)]')}>{t('devices.addServer.prompt.noticeTitle')}</div>
    const label = prompt.label && <div className={cn(text, 'text-[var(--muted-fg)]')}>{prompt.label}</div>
    const waiting = (
      <span className="flex min-w-0 items-center gap-2" role="status">
        <LoadingIndicator size="inline" />
        <span className="truncate">{t('devices.addServer.prompt.noticeWaiting')}</span>
      </span>
    )
    if (floating) {
      return (
        <SshPromptFrame context={context} testId="add-server-prompt-notice" onKeyDown={onEscape} status={waiting} actions={cancelButton}>
          {title}
          {label}
        </SshPromptFrame>
      )
    }
    return (
      <div className={calloutClassName('ask')} data-testid="add-server-prompt-notice">
        {title}
        {label}
        <div className={cn(caption, 'text-[var(--faint-fg)]')}>{waiting}</div>
      </div>
    )
  }

  const title =
    prompt.kind === 'password'
      ? prompt.subject
        ? t('devices.addServer.prompt.passwordFor', { subject: prompt.subject })
        : t('devices.addServer.prompt.passwordTitle')
      : prompt.kind === 'passphrase'
        ? t('devices.addServer.prompt.passphraseTitle')
        : t('devices.addServer.prompt.otpTitle')
  const subtitle =
    prompt.kind === 'passphrase' && prompt.subject
      ? t('devices.addServer.prompt.passphraseFor', { subject: prompt.subject })
      : prompt.kind === 'otp'
        ? prompt.label
        : null
  const retry =
    prompt.retry &&
    (prompt.kind === 'password'
      ? t('devices.addServer.prompt.retryPassword')
      : prompt.kind === 'passphrase'
        ? t('devices.addServer.prompt.retryPassphrase')
        : t('devices.addServer.prompt.retryOtp'))
  const note = prompt.kind !== 'otp' ? t('devices.addServer.prompt.secretNote') : null
  const submit = !busy && (
    <Button size="sm" variant="primary" type="submit">{t('devices.addServer.prompt.submit')}</Button>
  )

  const input = (
    <Field.Input
      autoFocus
      variant={floating ? 'bare' : 'default'}
      type={visible ? 'text' : 'password'}
      value={value}
      placeholder={
        prompt.kind === 'password'
          ? t('devices.addServer.prompt.placeholderPassword')
          : prompt.kind === 'passphrase'
            ? t('devices.addServer.prompt.placeholderPassphrase')
            : t('devices.addServer.prompt.placeholderOtp')
      }
      disabled={busy}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete={prompt.kind === 'otp' ? 'one-time-code' : 'off'}
      className={floating ? 'flex-1' : 'pr-10'}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={trackCaps}
      onKeyUp={trackCaps}
      data-testid="add-server-secret"
    />
  )
  const eye = (
    <IconButton
      size="sm"
      className={floating ? 'shrink-0' : 'absolute right-1 top-1/2 -translate-y-1/2'}
      aria-label={visible ? t('devices.addServer.prompt.hide') : t('devices.addServer.prompt.show')}
      aria-pressed={visible}
      disabled={busy}
      onClick={() => setVisible((v) => !v)}
    >
      {visible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
    </IconButton>
  )
  const capsLine = capsLock && !visible && !busy && (
    <Field.Description className="text-[var(--fg)]">{t('devices.addServer.prompt.capsLock')}</Field.Description>
  )
  // 默认不勾(照 Tabby 密码框下的 Remember):往那台机器上写东西要人自己点头。
  const keyOption = offerKey && (
    <label className={cn(text, 'flex cursor-pointer items-center gap-2 text-[var(--fg)]', busy && 'cursor-default opacity-60')}>
      <input
        type="checkbox"
        className="m-0"
        checked={installKey}
        disabled={busy}
        onChange={(e) => onInstallKeyChange(e.currentTarget.checked)}
        data-testid="ssh-prompt-install-key"
      />
      <span>{t('devices.addServer.prompt.installKey')}</span>
    </label>
  )
  const retryLine = retry && !busy && (
    <div className={cn(floating ? caption : text, 'text-[var(--danger-fg)]')} role="alert" data-testid="ssh-prompt-retry">{retry}</div>
  )
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    answer(value)
    setValue('')
  }

  if (floating) {
    return (
      <SshPromptFrame
        as="form"
        onSubmit={onSubmit}
        context={context}
        testId={`add-server-prompt-${prompt.kind}`}
        onKeyDown={onEscape}
        status={connecting || note}
        actions={
          <>
            {cancelButton}
            {submit}
          </>
        }
      >
        <Field.Root className="gap-1">
          <Field.Label className={cn(text, 'font-semibold text-[var(--fg)]')}>{title}</Field.Label>
          {subtitle && <div className={cn(caption, 'break-all text-[var(--muted-fg)]')}>{subtitle}</div>}
          {/* 输入带:光标就是焦点,❌ 框里再套一圈边框 + 主色焦点环(与命令面板的搜索行同一个做法)。 */}
          <div className="flex min-h-[var(--control-h-md)] items-center gap-2">
            {input}
            {eye}
          </div>
          {retryLine}
          {capsLine}
          {keyOption}
        </Field.Root>
      </SshPromptFrame>
    )
  }

  return (
    <form onSubmit={onSubmit} onKeyDown={onEscape} className={calloutClassName('ask')} data-testid={`add-server-prompt-${prompt.kind}`}>
      <div className={cn(text, 'font-semibold text-[var(--fg)]')}>{title}</div>
      {subtitle && <div className={cn(text, 'break-all text-[var(--muted-fg)]')}>{subtitle}</div>}
      {retryLine}
      <Field.Root>
        <Field.Label className="sr-only">{title}</Field.Label>
        <div className="relative">
          {input}
          {eye}
        </div>
        {capsLine}
        {note && <Field.Description>{note}</Field.Description>}
      </Field.Root>
      {keyOption}
      {/* 添加机器:不要了就点底下那颗「取消」(整次安装一起停);那里 ❌ 再摆一颗意思不同的「取消」。 */}
      <div className={cn(caption, 'flex items-center justify-end gap-2 text-[var(--faint-fg)]')}>
        {connecting || (
          <>
            {cancelButton}
            {submit}
          </>
        )}
      </div>
    </form>
  )
}

/**
 * floating 卡片的骨架(Zed RemoteConnectionModal 的三段):哪台机器 / 问题本身 / 状态 + 按钮。
 * 只画内容分段;浮层本身(圆角、lift、底色、定位)归调用处的浮卡(会话页 RemoteFloatingCard)。
 * 直连终端「指纹变了」那张拒绝卡片也用它,两张卡片长成一家。
 */
export function SshPromptFrame({
  context,
  children,
  status,
  actions,
  testId,
  as = 'div',
  onSubmit,
  onKeyDown,
  role,
}: {
  context?: SshPromptContext | null
  children: ReactNode
  /** 底行左侧:一句说明(「只交给 ssh 用」)或正在发生的事(LoadingIndicator + 一句话)。 */
  status?: ReactNode
  actions?: ReactNode
  testId?: string
  as?: 'div' | 'form'
  onSubmit?: (event: FormEvent) => void
  onKeyDown?: (event: KeyboardEvent) => void
  role?: string
}) {
  const Tag = as
  return (
    <Tag
      className="flex flex-col"
      data-testid={testId}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      role={role}
    >
      {context && (
        <div className="flex min-w-0 items-center gap-2 border-b border-[var(--border)] px-4 py-2" data-testid="ssh-prompt-context">
          <Server aria-hidden className="size-3.5 shrink-0 text-[var(--faint-fg)]" />
          <span className={cn(text, 'max-w-[60%] shrink-0 truncate font-[var(--font-weight-medium)] text-[var(--fg)]')}>{context.name}</span>
          {context.detail && <span className={cn(caption, 'min-w-0 truncate text-[var(--muted-fg)]')}>{context.detail}</span>}
        </div>
      )}
      <div className="flex flex-col gap-2 px-4 py-3">{children}</div>
      {(status || actions) && (
        <div className="flex min-h-[calc(var(--control-h-sm)+16px)] items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2">
          <div className={cn(caption, 'min-w-0 flex-1 text-[var(--faint-fg)]')}>{status}</div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
    </Tag>
  )
}
