import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { useTranslation } from 'react-i18next';
import { cloudComputerFailureKindOf } from '@gugu/core/cloud/cloudComputer';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { AssistantCtx } from './assistant-context';
import { wakeAssistantMachine, type MachineReadiness } from './assistant-data';
import { useReadFailure } from './assistant-read-failure';
import { AssistantEmpty } from './assistant-ui-parts';

export * from './assistant-ui-parts';

/**
 * #7199 owner 10-17:Agent 没有休息这回事 —— 要读它家里的东西、它住的云端宿主正收回着,由系统自己叫起来(❌ 让人按「叫醒它」),
 * 界面只说「正在连接」。每台每挂上一次只叫一次(开着时它又被收回 ❌ 再叫,那样宿主永远收不回);没叫起来时交出原因,由页面说 + 重试。
 * observer 里调(读 remoteHostsStore)。
 */
export function useWakeHomeForRead(
  deviceId: string | null,
  readiness: MachineReadiness,
): { failure: string | null; dropped: boolean; unsupported: boolean; retry: () => void } {
  const asked = useRef<string | null>(null);
  // 这个宿主叫不了它(老宿主没有那一格,叫的结果是 false、也没记原因):说连不上,❌ 给一个按了也没用的「重新连接」。
  const [unsupportedFor, setUnsupportedFor] = useState<string | null>(null);
  const wake = useCallback((target: string) => {
    void wakeAssistantMachine(target).then((woke) => {
      if (!woke && !remoteHostsStore.wakeFailure(target)) setUnsupportedFor(target);
    });
  }, []);
  useEffect(() => {
    if (!deviceId || readiness !== 'asleep' || asked.current === deviceId) return;
    asked.current = deviceId;
    wake(deviceId);
  }, [deviceId, readiness, wake]);
  const retry = useCallback(() => {
    if (deviceId) wake(deviceId);
  }, [deviceId, wake]);
  const unsupported = deviceId !== null && unsupportedFor === deviceId;
  const failure = deviceId ? remoteHostsStore.wakeFailure(deviceId) : null;
  // 这一挂叫过一次、它又被收回了、此刻没在叫:「连接断了」+ 重新连接(❌ 自己再叫 —— 页面开着它就永远收不回)。
  const dropped =
    !failure &&
    !unsupported &&
    readiness === 'asleep' &&
    deviceId !== null &&
    asked.current === deviceId &&
    remoteHostsStore.wakes.get(deviceId)?.status !== 'waking';
  return { failure: failure ? cloudComputerFailureKindOf(failure) : null, dropped, unsupported, retry };
}

/** 没叫起来的那一句:「连不上 X：」+ 那一类原因(common `cloudComputer.reason.*`)+ 重试;连接断了(kind = null):「和 X 的连接断了」+ 重新连接。 */
export function HomeWakeFailure({ name, kind, onRetry }: { name: string; kind: string | null; onRetry: () => void }) {
  const { t } = useTranslation('assistant');
  const { t: tc } = useTranslation('common');
  return (
    <AssistantEmpty
      action={
        <button type="button" className="ta-pill-btn" onClick={onRetry} data-testid="assistant-connect-retry">
          {kind ? t('machine.retry') : t('machine.reconnect')}
        </button>
      }
    >
      <span role={kind ? 'alert' : 'status'} data-testid="assistant-connect-failed" data-kind={kind ?? 'dropped'}>
        {kind ? (
          <>
            {t('machine.connectFailed', { name })}
            {tc(`cloudComputer.reason.${kind}`)}
          </>
        ) : (
          t('machine.dropped', { name })
        )}
      </span>
    </AssistantEmpty>
  );
}

/**
 * 要读它家里东西的那几块,在读到之前说清是哪一步:正在连接(收回着的云端宿主由系统叫起来)/ 连不上(带原因与重试)/
 * 读的时候出错(带重试)。说的都是它本人,❌ 说它住的那台机器(owner 10-15:用户看不到它住在哪),❌ 说它在休息(owner 10-17)。
 * 读到了才画 children。❌ 读不到时画一个空列表冒充「什么都没有」。
 */
export const MachineGate = observer(function MachineGate({
  readiness,
  loading,
  error,
  onRetry,
  children,
}: {
  readiness: MachineReadiness;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('assistant');
  const context = useContext(AssistantCtx);
  const name = context?.assistant.display_name ?? '';
  const cloudHome = context?.home.kind === 'cloud' ? context.homeDeviceId : null;
  const wake = useWakeHomeForRead(cloudHome, readiness);
  const failure = useReadFailure(error, context?.homeDeviceId ?? null, name, onRetry);
  if ((wake.failure || wake.dropped) && readiness !== 'ready') return <HomeWakeFailure name={name} kind={wake.failure} onRetry={wake.retry} />;
  if (wake.unsupported && readiness !== 'ready') return <AssistantEmpty>{t('machine.unreachable', { name })}</AssistantEmpty>;
  if (readiness === 'unreachable') {
    // 住在人的另一台电脑上:那台关着 / 连不上就是读不到 —— 说它住在哪台、那台开着它才在(❌「叫醒」)。
    const home = context?.home;
    if (home?.kind === 'computer')
      return <AssistantEmpty>{home.known ? t('machine.computerOff', { name, device: home.label ?? '' }) : t('machine.computerGone', { name })}</AssistantEmpty>;
    return <AssistantEmpty>{t('machine.unreachable', { name })}</AssistantEmpty>;
  }
  if (readiness === 'asleep' || readiness === 'waiting')
    return (
      <AssistantEmpty>
        <span className="inline-flex items-center gap-2" data-testid="assistant-connecting">
          <LoadingIndicator size="inline" />
          {t('machine.connecting', { name })}
        </span>
      </AssistantEmpty>
    );
  if (failure)
    return (
      <AssistantEmpty
        action={
          failure.retry ? (
            <button type="button" className="ta-pill-btn" onClick={failure.retry}>
              {t('machine.retry')}
            </button>
          ) : undefined
        }
      >
        {failure.text}
      </AssistantEmpty>
    );
  if (loading)
    return (
      <AssistantEmpty>
        <LoadingIndicator size="inline" />
      </AssistantEmpty>
    );
  return <>{children}</>;
});
