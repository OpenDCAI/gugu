import { messageForUser } from '@/lib/userFacingError';
import { CheckCircle, Copy, ExternalLink, Eye, EyeOff, Info } from '@/lib/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { LibraryHostScope } from '@renderer/features/library/library-host-scope';
import { useLibraryHost, type LibraryHost } from '@renderer/features/library/library-host';
import {
  useIntegrationsContext,
  type CliLoginStartResult,
  type IntegrationMetadata,
} from './integrations-provider';
import {
  canSubmitForm,
  cliMethodOf as cliMethod,
  formInputOf,
  formMethodOf as formMethod,
  initialFormValues,
  usesBrowserAuthorization,
} from './integration-setup-model';
import { SetupFormShell } from './SetupFormShell';
import type { SetupIntegrationType } from './types';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { openAuthorizationLink } from '@/lib/openAuthorizationLink';
import { CliInstallProgress } from './CliInstallProgress';

type IntegrationSetupModalArgs = {
  integration: SetupIntegrationType;
  /** 资源库看的是别的机器时,连的是那台机器上的集成(#6264);不给 = 本机。 */
  host?: LibraryHost;
  /** #7240「编辑凭据」:改哪个已存账号,不保密那几项存着的值(预填)。 */
  editAccount?: { accountId: string; fields: Record<string, string> };
};

type Props = BaseModalProps<void> & IntegrationSetupModalArgs;

export function IntegrationSetupModal({ host, ...props }: Props) {
  return (
    <LibraryHostScope host={host}>
      <IntegrationSetupModalBody {...props} />
    </LibraryHostScope>
  );
}

function IntegrationSetupModalBody({ integration, editAccount, onSuccess, onClose }: Omit<Props, 'host'>) {
  const { integrationById } = useIntegrationsContext();
  const { translate } = useSessionMessages();
  const metadata = integrationById[integration];

  return (
    <>
      <DialogHeader className="flex-col items-start gap-1" showCloseButton={false}>
        <DialogTitle>
          {metadata
            ? translate(editAccount ? 'integrations.editCredentialsTitle' : 'integrations.connectTitleFor', {
                name: metadata.name,
              })
            : translate('integrations.setupTitle')}
        </DialogTitle>
      </DialogHeader>
      {metadata ? (
        cliMethod(metadata) ? (
          <IntegrationCliLogin
            integration={integration}
            metadata={metadata}
            onSuccess={onSuccess}
            onClose={onClose}
          />
        ) : usesBrowserAuthorization(metadata) ? (
          <IntegrationBrowserAuthorization
            integration={integration}
            metadata={metadata}
            onSuccess={onSuccess}
            onClose={onClose}
          />
        ) : (
          <IntegrationSetupForm
            integration={integration}
            metadata={metadata}
            {...(editAccount ? { editAccount } : {})}
            onSuccess={onSuccess}
            onClose={onClose}
          />
        )
      ) : null}
    </>
  );
}

// 点「前往授权」→ 主进程打开浏览器授权页并等回调;用户在浏览器里同意后这边自己收尾。
// 没有要填的东西,所以这里不是表单:一句说明、一个等待态、失败时原样给出原因。
function IntegrationBrowserAuthorization({
  integration,
  metadata,
  onSuccess,
  onClose,
}: {
  integration: SetupIntegrationType;
  metadata: IntegrationMetadata;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const { authorizeIntegration, cancelIntegrationAuthorization } = useIntegrationsContext();
  const remote = useLibraryHost().remote;
  const { toast } = useToast();
  const { translate } = useSessionMessages();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waitingRef = useRef(false);

  // 关掉弹窗 = 放弃这次授权。主进程的回调监听要一起撤掉,否则浏览器里晚到的同意会在用户
  // 以为已经取消之后,悄悄把账号连上。
  useEffect(
    () => () => {
      if (waitingRef.current) cancelIntegrationAuthorization(integration);
    },
    [cancelIntegrationAuthorization, integration]
  );

  const start = async () => {
    setError(null);
    setWaiting(true);
    waitingRef.current = true;
    try {
      const result = await authorizeIntegration(integration);
      if (!result.success) {
        // @@@raw detail — 主进程/授权服务器给的失败原因原样展示。
        setError(result.error);
        return;
      }
      toast({
        title: translate('integrations.connectedToast'),
        description: translate('integrations.connectedToastDescription'),
      });
      onSuccess();
    } finally {
      waitingRef.current = false;
      setWaiting(false);
    }
  };

  return (
    <>
      <DialogContentArea className="pt-1">
        <p className="text-sm text-foreground-muted">
          {waiting
            ? translate('integrations.browserAuthWaiting', { name: metadata.name })
            : remote
              ? // 授权在这台电脑的浏览器里做,连接存在那台机器上(#6264):说清两处各是哪台。
                translate('deviceScope.browserAuthOnDevice', { name: metadata.name, device: remote.deviceLabel })
              : translate('integrations.browserAuthDescription', { name: metadata.name })}
        </p>
        {error ? (
          <p className="text-xs text-foreground-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        <ConfirmButton onClick={() => void start()} disabled={waiting}>
          {waiting ? (
            <LoadingIndicator size="inline" className="mr-2" />
          ) : (
            <ExternalLink className="mr-2 h-4 w-4" />
          )}
          {error
            ? translate('integrations.browserAuthRetry')
            : translate('integrations.browserAuthAction')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}

type CliPrompt = Extract<CliLoginStartResult, { prompt: unknown }>['prompt'];

/**
 * #7210 官方命令行(钉钉 dws、企业微信 wecom-cli),交互是「连接」:一个主按钮 →「正在连接」→ 对方 App 里确认 →
 * 已连接。另有一块「先决条件」:钉钉要组织管理员先开「CLI 访问」,点连接之前就说清找谁、去哪开。
 *
 * 工具装在、登录跑在资源库选中的那台机器上(云电脑也一样);这里只把它给的授权链接 / 二维码拿来给人看。
 */
function IntegrationCliLogin({
  integration,
  metadata,
  onSuccess,
  onClose,
}: {
  integration: SetupIntegrationType;
  metadata: IntegrationMetadata;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const method = cliMethod(metadata);
  const { startCliLogin, waitCliLogin, readCliProgress, cancelIntegrationAuthorization } = useIntegrationsContext();
  const readProgress = useCallback(() => readCliProgress?.(integration) ?? Promise.resolve(null), [readCliProgress, integration]);
  const remote = useLibraryHost().remote;
  const { toast } = useToast();
  const { translate } = useSessionMessages();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting'>('idle');
  const [prompt, setPrompt] = useState<CliPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 关掉弹窗 = 放弃这次登录:那台机器上的登录进程一起撤掉,❌ 让它在后台等十五分钟。
  const activeRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeRef.current) cancelIntegrationAuthorization(integration);
    };
  }, [cancelIntegrationAuthorization, integration]);

  if (!method) return null;

  const start = async () => {
    setError(null);
    setPrompt(null);
    setPhase('starting');
    activeRef.current = true;
    try {
      const started = await startCliLogin(integration);
      // 装到一半关了弹窗:关的那一刻已经撤了这一次(主进程见号作废,不再起登录),这里不必、也❌ 再撤一次 ——
      // 那会撤掉人重新打开弹窗后起的新登录。
      if (!mountedRef.current) return;
      if (!started.success) {
        // @@@raw detail — 安装 / 工具自己说的失败原因原样给出。
        setError(started.error);
        return;
      }
      if ('connected' in started) {
        activeRef.current = false;
        toast({ title: translate('integrations.cliConnectedToast', { name: metadata.name }) });
        onSuccess();
        return;
      }
      setPrompt(started.prompt);
      setPhase('waiting');
      for (;;) {
        const result = await waitCliLogin(integration);
        if (!mountedRef.current) return;
        if (result.status === 'pending') {
          if (result.prompt) setPrompt(result.prompt);
          continue;
        }
        if (result.status === 'failed') {
          setError(result.error);
          return;
        }
        activeRef.current = false;
        toast({ title: translate('integrations.cliConnectedToast', { name: metadata.name }) });
        onSuccess();
        return;
      }
    } catch (failure) {
      if (mountedRef.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mountedRef.current) {
        activeRef.current = false;
        setPhase('idle');
      }
    }
  };

  const openUrl = (url: string) => void openAuthorizationLink(url).catch((failure: unknown) => {
    if (mountedRef.current) setError(failure instanceof Error ? failure.message : String(failure));
  });
  const copyUrl = async (url: string) => {
    try { await navigator.clipboard.writeText(url); } catch (failure) { console.error(failure); setError(messageForUser(failure)); return; }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const promptUrl = prompt?.url;
  // 授权页要在别的设备上打开(手机上的钉钉、另一台电脑)时用。
  const copyLink = promptUrl ? (
    <Button variant="link" size="xs" className="h-auto justify-self-start p-0 text-xs" onClick={() => void copyUrl(promptUrl)}>
      {copied ? <CheckCircle className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
      {copied ? translate('integrations.cliLinkCopied') : translate('integrations.cliCopyLink')}
    </Button>
  ) : null;

  return (
    <>
      <DialogContentArea className="grid gap-3 pt-1">
        {phase === 'waiting' && prompt ? (
          prompt.kind === 'device-link' ? (
            <div className="grid gap-2">
              <p className="text-sm text-foreground-muted">
                {translate('integrations.cliDeviceLinkHint', { name: metadata.name })}
              </p>
              {prompt.code ? <div className="flex items-center justify-between rounded-lg border border-border bg-background-secondary px-3 py-2">
                <span className="text-xs text-foreground-muted">{translate('integrations.cliDeviceCode')}</span>
                <span className="font-mono text-base font-semibold tracking-widest text-foreground" data-testid="cli-device-code">
                  {prompt.code}
                </span>
              </div> : null}
              {copyLink}
            </div>
          ) : (
            <div className="grid justify-items-center gap-2">
              <img
                src={prompt.image}
                alt={translate('integrations.cliQrAlt', { name: metadata.name })}
                className="size-44 rounded-lg border border-border bg-white p-1"
              />
              <p className="text-sm text-foreground-muted">{translate('integrations.cliQrHint', { name: metadata.name })}</p>
              {copyLink}
            </div>
          )
        ) : (
          <>
            <p className="text-sm text-foreground-muted">
              {remote
                ? translate('integrations.cliDescriptionOnDevice', { name: metadata.name, device: remote.deviceLabel })
                : translate('integrations.cliDescription', { name: metadata.name })}
            </p>
            {method.prerequisite ? (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-background-secondary px-3 py-2">
                <Info className="h-4 w-4 shrink-0 text-foreground-muted" />
                <div className="grid gap-1">
                  {/* @@@raw prerequisite copy — 插件元数据里的中英两份,主进程已按界面语言挑好。 */}
                  <p className="text-xs text-foreground">{method.prerequisite.text}</p>
                  {method.prerequisite.url ? (
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto justify-start p-0 text-xs"
                      onClick={() => openUrl(method.prerequisite!.url!)}
                    >
                      {translate('integrations.cliPrerequisiteLink')}
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {phase === 'starting' ? (
              <div className="grid gap-2">
                <p className="text-xs text-foreground-muted">{translate('integrations.cliPreparing', { name: metadata.name })}</p>
                <CliInstallProgress read={readProgress} />
              </div>
            ) : null}
          </>
        )}
        {phase === 'waiting' ? (
          <div className="flex items-center gap-2 text-xs text-foreground-muted" role="status">
            <LoadingIndicator size="inline" />
            {translate('integrations.cliWaiting')}
          </div>
        ) : null}
        {error ? (
          <p className="whitespace-pre-wrap text-xs text-foreground-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        {phase === 'waiting' && promptUrl && (prompt?.kind === 'device-link' || method.tool === 'lark-cli') ? (
          <ConfirmButton onClick={() => openUrl(promptUrl)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            {translate('integrations.cliOpenAuthorizePage', { name: metadata.name })}
          </ConfirmButton>
        ) : phase === 'waiting' ? null : (
          <ConfirmButton onClick={() => void start()} disabled={phase === 'starting'}>
            {phase === 'starting' ? <LoadingIndicator size="inline" className="mr-2" /> : null}
            {phase === 'starting'
              ? translate('integrations.cliConnecting')
              : error
                ? translate('integrations.cliRetry')
                : translate('integrations.connectAction')}
          </ConfirmButton>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * 填表连的那几家走「授权配置」(`connectors.credentials.*`,#7240):每格有名字;保密的那格能「显示 / 隐藏」;
 * 说明下面一个「如何获取授权码」直达对方的帮助页;「保存并连接」→「正在验证…」。
 * 「编辑凭据」时预填存着的不保密那几项,保密那格留空 =「已保存,留空则保留」;认人的那格(邮箱地址)不让改 ——
 * 改了就是另一个账号,该去「添加另一个账号」。
 */
function IntegrationSetupForm({
  integration,
  metadata,
  editAccount,
  onSuccess,
  onClose,
}: {
  integration: SetupIntegrationType;
  metadata: IntegrationMetadata;
  editAccount?: { accountId: string; fields: Record<string, string> };
  onSuccess: () => void;
  onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const method = formMethod(metadata);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialFormValues(method?.fields ?? [], editAccount?.fields)
  );
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());

  const canSubmit = useMemo(
    () => !!method && canSubmitForm(method.fields, values, !!editAccount),
    [method, values, editAccount]
  );

  if (!method) return null;

  const updateField = (id: string, value: string) => {
    setValues((current) => ({ ...current, [id]: value }));
  };
  const toggleReveal = (id: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const secretLabel = method.fields.find((field) => field.secret)?.label;

  return (
    <SetupFormShell
      providerId={integration}
      {...(editAccount ? { editAccountId: editAccount.accountId } : {})}
      getInput={() => formInputOf(method.fields, values)}
      canSubmit={canSubmit}
      onSuccess={onSuccess}
      onClose={onClose}
    >
      <div className="grid gap-3">
        {method.fields.map((field, index) => {
          const locked = !!editAccount && field.id === 'email';
          const shown = revealed.has(field.id);
          return (
            <div key={field.id} className="grid gap-1.5">
              {/* @@@raw field copy — provider 自带的 label/placeholder 是集成元数据,主进程已按界面语言挑好。 */}
              <label htmlFor={`integration-field-${field.id}`} className="text-xs text-foreground-muted">
                {field.label}
                {field.required && !(editAccount && field.secret) ? translate('integrations.requiredFieldSuffix') : ''}
              </label>
              <div className="relative">
                <Input
                  id={`integration-field-${field.id}`}
                  type={field.secret && !shown ? 'password' : 'text'}
                  placeholder={
                    editAccount && field.secret
                      ? translate('integrations.credentialsSavedPlaceholder', { label: field.label })
                      : (field.placeholder ?? field.label)
                  }
                  value={values[field.id] ?? ''}
                  onChange={(event) => updateField(field.id, event.target.value)}
                  className={field.secret ? 'h-9 w-full pr-9' : 'h-9 w-full'}
                  autoComplete="off"
                  readOnly={locked}
                  disabled={locked}
                  autoFocus={editAccount ? field.secret : index === 0}
                />
                {field.secret ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute top-1/2 right-1.5 -translate-y-1/2"
                    aria-label={translate(shown ? 'integrations.credentialsHide' : 'integrations.credentialsShow')}
                    onClick={() => toggleReveal(field.id)}
                  >
                    {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
        {method.help ? <p className="text-xs leading-5 text-foreground-muted">{method.help}</p> : null}
        {method.helpUrl ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto justify-self-start p-0 text-xs"
            aria-label={translate('integrations.setupGuideLabel', { name: metadata.name })}
            onClick={() => window.open(method.helpUrl, '_blank', 'noopener,noreferrer')}
          >
            {secretLabel
              ? translate('integrations.credentialsHelp', { label: secretLabel })
              : translate('integrations.setupGuideLabel', { name: metadata.name })}
            <ExternalLink className="ml-1 h-3 w-3" />
          </Button>
        ) : null}
      </div>
    </SetupFormShell>
  );
}
