import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Copy } from '@/lib/icons'
// 「复制去那台机器上敲」的一行命令:与设置 → 设备里那几处同一个 CommandBlock,❌ 另写一份孪生体。
import { CommandBlock } from '@/components/settings/addServer/CommandBlock';
import '@/i18n/registerSettingsCatalog';
import { reaction } from 'mobx';
import { useEffect, useRef, useState } from 'react';
import { AcpAuthLoginBinding } from '@renderer/lib/acp/auth-login-binding';
import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { copyExternalLink, openExternalLinkInBrowser } from '@renderer/lib/open-external-link';
import { cancelsLoginOnClose, loginAttemptSucceeded, pendingUrlToOpen, rereadOnReturn } from './login-success';
import { AcpAuthenticateSignIn } from './AcpAuthenticateSignIn';
import { resolveSignInMethods } from './agent-account';
import { useAgent } from '@renderer/lib/stores/use-agents';
import { SignInTitle } from './SignInTitle';
import { isPrimaryMouseButton } from '@renderer/lib/pty/file-link-provider';
import {
  buildTheme,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  TERMINAL_PADDING_PX,
} from '@renderer/lib/pty/pty';
import { computeGridDimensions, measureTerminalCell } from '@renderer/lib/pty/pty-dimensions';
import { buildTerminalFontFamily } from '@renderer/lib/pty/terminal-font';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { TERMINAL_FONT_SIZE_DEFAULT } from '@shared/core/terminals/terminal-settings';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

/**
 * #6264 登录发生在**别的机器上**(会话 / 新建框在那台机器上)。窗口还是这一个、绑定也是同一个
 * (那台机器的 agent-config 运行时,一套工作台),只是:
 *  · 跑这家「不靠回跳」的登录方式(设备码 / 把码贴回终端)—— 浏览器在这台电脑上,回跳到不了那台机器;
 *  · 这家没有这种登录方式时,不起终端,如实说「到那台机器的终端里敲哪条命令」。
 */
export type AgentSignInRemoteTarget = {
  deviceId: string;
  deviceLabel: string;
  /** 这家声明了不靠回跳的登录方式(`headlessArgs`)。 */
  headless: boolean;
  /** 只能自己登时,在那台机器终端里要敲的命令。 */
  command: string;
};

/** 一步登录:哪个方法、哪个程序、怎么登。 */
export type AgentSignInStep = {
  methodId: string;
  /**
   * 登哪个程序(#6335)。缺席 = 主程序;给了 = 那个伴随程序(Antigravity 终端腿的 `agy`)——
   * 两个程序不共享登录,各有各的登录进程与读数。
   */
  program?: string;
  /**
   * 这个方法怎么登:`terminal`(缺席即此)= 起终端跑 `<cli> login`;`acp-authenticate` = 咕咕替它发
   * 协议登录,厂商自己开浏览器 —— 同一个弹窗入口,❌ 不另起一个平行的登录弹窗(#6335)。
   */
  transport?: 'terminal' | 'acp-authenticate';
};

export type AgentSignInModalArgs = {
  connectionId?: string;
  providerId: string;
  providerName: string;
  /**
   * 这一下要依次跑的几步(#6335)。一个程序的家永远是一步,与从前一模一样;一家几个程序、各自登录时,
   * 资源库那一行只有一颗按钮,点下去把还没登的那几个**按顺序**登完(全都登了就全部重登)。
   * 一步成功(或用户点「完成」)就接着下一步;任何一步取消 / 关窗即整趟结束,已经登上的照样算数。
   */
  steps: AgentSignInStep[];
  /** #6264 在别的机器上登(只走终端登录那一种,一步)。 */
  remote?: AgentSignInRemoteTarget;
};

/** 登录绑定的那张面 —— 本机与远端各一种,窗口不分。 */
type LoginBinding = Pick<AcpAuthLoginBinding, 'sendInput' | 'resize' | 'markUrlHandled' | 'dispose'> & {
  status: { current(): AuthStatusModelState };
  /** 再问一次登录态(本机那种有;远端那台由它自己判成没成)。 */
  refreshStatus?: () => void;
};

type AgentSignInModalProps = BaseModalProps<void> & AgentSignInModalArgs;

type StepProps = BaseModalProps<void> & {
  connectionId?: string;
  providerId: string;
  providerName: string;
  methodId: string;
  program?: string;
  /** 多步时标题旁的「第 1 步,共 2 步」;单步为 null,❌ 不多画。 */
  stepLabel: string | null;
  remote?: AgentSignInRemoteTarget;
};

export function AgentSignInModal({ providerId, providerName, steps, remote, connectionId, onSuccess, onClose }: AgentSignInModalProps) {
  const { translate } = useSessionMessages();
  const [index, setIndex] = useState(0);
  // 这一步的程序声明了不止一种登录方法(CodeBuddy 国际版 / 中国版)时,先让用户挑;挑过的按步记着。
  const agent = useAgent(providerId).data;
  const [chosen, setChosen] = useState<Record<number, string>>({});
  // 远端但这家登不了 / 宿主给不了:不起终端,说清楚下一步。
  if (remote && !remote.headless) {
    const values = { provider: providerName, device: remote.deviceLabel };
    return (
      <>
        <DialogHeader>
          <DialogTitle>{translate('remoteLogin.title', values)}</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-3">
          <p className="text-sm text-foreground">{translate('remoteLogin.unsupported', values)}</p>
          <CommandBlock command={remote.command} />
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translate('common.close')}
          </Button>
        </DialogFooter>
      </>
    );
  }
  const listed = steps[index];
  if (!listed) return null;
  // 远端只走终端登录那一种(见 `remote`),不摆选择。
  const choices = remote ? [] : resolveSignInMethods(agent?.capabilities, listed.program);
  if (choices.length > 1 && chosen[index] === undefined) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{translate('agentsPage.signInChooseMethod', { provider: providerName })}</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-2">
          {choices.map((method) => (
            <Button
              key={method.id}
              variant="outline"
              className="justify-start"
              data-testid={`agent-sign-in-method-${method.id}`}
              onClick={() => setChosen((current) => ({ ...current, [index]: method.id }))}
            >
              {method.name}
            </Button>
          ))}
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translate('common.cancel')}
          </Button>
        </DialogFooter>
      </>
    );
  }
  const picked = choices.find((method) => method.id === chosen[index]);
  const step: AgentSignInStep = picked
    ? {
        ...listed,
        methodId: picked.id,
        transport: picked.kind === 'acp-authenticate' ? 'acp-authenticate' : 'terminal',
      }
    : listed;
  const last = index >= steps.length - 1;
  const props: StepProps = {
    connectionId,
    providerId,
    providerName,
    methodId: step.methodId,
    ...(step.program === undefined ? {} : { program: step.program }),
    stepLabel:
      steps.length > 1 ? translate('agentsPage.signInStep', { current: String(index + 1), total: String(steps.length) }) : null,
    ...(remote ? { remote } : {}),
    onSuccess: last ? onSuccess : () => setIndex((current) => current + 1),
    onClose,
  };
  // key 按步:换一步就是换一趟登录,上一步的绑定随卸载收尾。协议登录只在本机(远端只走终端登录)。
  return step.transport === 'acp-authenticate' && !remote ? (
    <AcpAuthenticateSignIn key={index} {...props} />
  ) : (
    <TerminalSignIn key={index} {...props} />
  );
}

function TerminalSignIn({
  connectionId,
  providerId,
  methodId,
  program,
  providerName,
  stepLabel,
  remote,
  onSuccess,
  onClose,
}: StepProps) {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [attempt] = useState(0);
  const { translate } = useSessionMessages();
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<LoginBinding | null>(null);
  const handledUrlsRef = useRef(new Set<string>());
  /**
   * 这次登录印出来的链接,摆在终端上方那一条里:「在系统浏览器中打开」「复制链接」。
   * ❌ 不再弹「打开链接?」:那个确认用的是全局唯一的弹窗位,一弹就把这个登录窗口顶掉(#6264 走查实撞:
   * 在确认上点「取消」,登录窗口跟着没了,那台机器上的登录命令却还在跑)。人自己点「打开」就是确认。
   */
  const [link, setLink] = useState<string | null>(null);
  const remoteDeviceId = remote?.deviceId ?? null;

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    let disposed = false;
    let animationFrame: number | null = null;
    const terminal = createLoginTerminal((url) => setLink(url));
    terminal.open(host);
    styleLoginTerminal(terminal);
    terminal.focus();

    const inputDisposable = terminal.onData((data) => {
      bindingRef.current?.sendInput(data);
    });
    const resize = () => {
      if (disposed) return;
      resizeLoginTerminal(terminal, host, bindingRef.current);
    };
    const observer = new ResizeObserver(() => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(resize);
    });
    observer.observe(host);
    resize();

    void AcpAuthLoginBinding.create({
      connectionId,
      providerId,
      methodId,
      program,
      terminal,
      // #6264 别的机器:在那台机器上跑这家不靠回跳的那种登录。
      ...(remoteDeviceId ? { machine: remoteDeviceId, headless: true } : {}),
    }).then(
      (binding) => {
        if (disposed) {
          binding.dispose();
          return;
        }
        bindingRef.current = binding;
        setReady(true);
        resize();
      },
      (err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    );

    return () => {
      disposed = true;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      observer.disconnect();
      inputDisposable.dispose();
      // 关窗(任何路径:关闭、Esc、点外面、切走、整个面板卸掉)取消不取消,判据在 `cancelsLoginOnClose`:
      //  · 本机 —— #4900 ❌ 不取消。设备码流程要人**离开这个窗口**去浏览器授权,厂商的 `<cli> login`
      //    必须活着才收得到那次授权(kimi owner 2026-09-04 实测);要中止走底部显式的「取消登录」。
      //  · 别的机器 —— 取消(已经登上的除外,绑定自己认)。窗口没了就再没人盯着那台机器上的登录命令,
      //    留着它只是一个挂在别人机器上的进程(#6264 走查:关窗 38 秒后它还在跑)。
      bindingRef.current?.dispose(cancelsLoginOnClose({ remote: !!remoteDeviceId }));
      bindingRef.current = null;
      terminal.dispose();
    };
  }, [methodId, program, providerId, remoteDeviceId, attempt, connectionId]);

  useEffect(() => {
    const binding = bindingRef.current;
    if (!binding || !ready) return;
    // 挂载这一刻的登录态是**登录前**的读数(`startLogin` 早已跑过),❌ 不能当成本次的结果。
    // 判据抽在 `login-success.ts`,那里记着为什么 —— 简版:拿它判成功,凭据过期的人和想换账号的人
    // 会看到弹窗开一帧就自己关了,他们永远登不上(#5705)。
    const progress = { sawInitialReading: false };
    /**
     * 这一趟是从「没登上」开始的吗 —— 是的话,用户从浏览器**回到这个窗口**那一下(`focus` 事件)再问一次
     * 登录态:登上了就按上面同一条判据收尾(多步时接着下一步)。
     *
     * 为什么要这一下:有的家登完不退出(Antigravity 的 `agy` 登完就停在自己的输入框里,#6335),
     * 而退出正是终端登录从前唯一会触发重读的事件 —— 没有它,用户得自己找「完成」去点。
     * 只挂在窗口获得焦点这个**事件**上,一次回来一次读数,❌ 不轮询(owner:不许密集轮询)。
     * 从「已登录」开始的那一趟(想换账号的重新登录)不挂:那时重读只会读到旧凭据,把弹窗在他还没
     * 换完的时候关掉(与 `loginAttemptSucceeded` 抬头那条同一个坑);它仍由「完成」或进程退出收尾。
     */
    let startedSignedOut: boolean | null = null;
    const onFocus = () => {
      if (startedSignedOut) binding.refreshStatus?.();
    };
    window.addEventListener('focus', onFocus);
    const stop = reaction(
      () => binding.status.current(),
      (state) => {
        startedSignedOut ??= rereadOnReturn(state);
      },
      { fireImmediately: true }
    );
    const stopMain = reaction(
      () => binding.status.current(),
      (state) => {
        if (loginAttemptSucceeded(state, progress)) {
          // 已经读到「登上了」⇒ 凭据落地了,本机这一趟的进程可以收掉(`dispose(true)`)。多数家此刻进程
          // 早已自己退出、收尾是空操作;登完不退出的家(`agy` 停在自己的输入框里)不收就会一直挂在后台。
          // ⚠️ 与关窗那条「❌ 不取消」不矛盾:那条防的是**还没**授权完就把进程杀了。
          binding.dispose(true);
          bindingRef.current = null;
          onSuccess();
          return;
        }
        progress.sawInitialReading = true;

        // ⚠️ `fireImmediately` 要留着:设备码流程的授权链接可能在首帧就已经在状态里(#4900)。
        const pendingUrl = pendingUrlToOpen(state, handledUrlsRef.current);
        if (!pendingUrl) return;
        handledUrlsRef.current.add(pendingUrl.id);
        setLink(pendingUrl.url);
        binding.markUrlHandled(pendingUrl.id);
      },
      { fireImmediately: true }
    );
    return () => {
      window.removeEventListener('focus', onFocus);
      stop();
      stopMain();
    };
  }, [onSuccess, ready, attempt, remoteDeviceId]);

  const remoteValues = remote ? { provider: providerName, device: remote.deviceLabel } : null;

  return (
    <>
      <DialogHeader>
        <SignInTitle
          title={remoteValues
            ? translate('remoteLogin.title', remoteValues)
            : translate('agentsPage.signInToProvider', { provider: providerName })}
          stepLabel={stepLabel}
        />
      </DialogHeader>
      <DialogContentArea className="flex h-[520px] flex-col gap-2 p-0">
        {link && (
          <div
            // 机器给出的原文 = 印在页上的东西:密度面板 + --radius-document,❌ 在对话框里再画一圈框。
            className="flex items-center gap-2 rounded-[var(--radius-document)] bg-foreground/[0.025] px-3 py-2 dark:bg-foreground/[0.04]"
            data-testid="agent-sign-in-link"
          >
            <span className="shrink-0 text-xs text-foreground-muted">{translate('agentsPage.signInLink')}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={link}>
              {link}
            </span>
            <Button variant="outline" size="sm" onClick={() => void copyExternalLink(link)}>
              <Copy className="h-4 w-4" />
              {translate('externalLink.copyLink')}
            </Button>
            <Button variant="default" size="sm" onClick={() => openExternalLinkInBrowser(link)}>
              {translate('preview.openInSystemBrowser')}
            </Button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <div
            ref={terminalHostRef}
            className="h-full rounded-md border border-border bg-(--xterm-bg)"
          />
          {!ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-foreground-muted">
              <LoadingIndicator
                ariaLabel={translate('agentsPage.signInStarting')}
                label={translate('agentsPage.signInStarting')}
              />
            </div>
          )}
          {error && (
            <div className="text-foreground-destructive absolute inset-0 bg-background p-4 text-sm">
              {error}
            </div>
          )}
        </div>
      </DialogContentArea>
      <DialogFooter className="flex-wrap items-center gap-2">
        <span className="mr-auto flex items-center gap-2 text-xs text-foreground-muted" data-testid="agent-sign-in-status">
          {translate('agentsPage.signInKeepsRunning')}
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            bindingRef.current?.dispose(true);
            bindingRef.current = null;
            onClose();
          }}
        >
          {translate('agentsPage.signInCancel')}
        </Button>
        <Button variant="outline" onClick={onClose}>
          {translate('common.close')}
        </Button>
        {/* 登录成不成只有 harness 自己知道,所以这一下不宣称成功,只是**再问一次**:
            onSuccess 那侧会重跑 bootstrap / 重读目录,没登上就照旧退回登录闸。 */}
        <Button variant="default" onClick={() => onSuccess()}>
          {translate('agentsPage.signInDone')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** 终端里点到的链接也只是摆到上方那一条里,由人点「打开」—— 同一个理由,见 `link` 抬头。 */
function createLoginTerminal(onLink: (url: string) => void): Terminal {
  const terminal = new Terminal({
    cols: 120,
    rows: 32,
    scrollback: 100_000,
    fontFamily: buildTerminalFontFamily(),
    fontSize: TERMINAL_FONT_SIZE_DEFAULT,
    lineHeight: TERMINAL_LINE_HEIGHT,
    letterSpacing: TERMINAL_LETTER_SPACING,
    allowProposedApi: true,
    scrollOnUserInput: false,
    linkHandler: {
      activate: (event, text) => {
        if (!isPrimaryMouseButton(event)) return;
        onLink(text);
      },
    },
    theme: buildTheme(),
    minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
  });
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!isPrimaryMouseButton(event)) return;
      event.preventDefault();
      onLink(uri);
    })
  );
  return terminal;
}

function styleLoginTerminal(terminal: Terminal): void {
  const element = (terminal as unknown as { element?: HTMLElement }).element;
  if (!element) return;
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.boxSizing = 'border-box';
  element.style.padding = `${TERMINAL_PADDING_PX}px`;
  element.style.backgroundColor = 'var(--xterm-bg)';
}

function resizeLoginTerminal(
  terminal: Terminal,
  host: HTMLElement,
  binding: LoginBinding | null
): void {
  const cell = measureTerminalCell(
    buildTerminalFontFamily(),
    TERMINAL_FONT_SIZE_DEFAULT,
    TERMINAL_LINE_HEIGHT,
    TERMINAL_LETTER_SPACING
  );
  if (!cell) return;
  const dims = computeGridDimensions({
    widthPx: host.clientWidth,
    heightPx: host.clientHeight,
    cellWidth: cell.width,
    cellHeight: cell.height,
    paddingPx: TERMINAL_PADDING_PX,
  });
  if (!dims) return;
  if (terminal.cols !== dims.cols || terminal.rows !== dims.rows) {
    terminal.resize(dims.cols, dims.rows);
  }
  binding?.resize(dims.cols, dims.rows);
}
