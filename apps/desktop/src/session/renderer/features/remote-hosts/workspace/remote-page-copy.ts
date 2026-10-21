// #6264 别的机器上的网页 / 端口:取不到、转不过来时说的那一句(交给主进程的预览协议 / 画成浏览器的加载失败页)。
// 原因只从闭集里取词条,❌ 把那台机器吐的原文塞进词条的占位符(原文进日志,user-copy-leak-check 的本意)。
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { RemotePortReason } from '@shared/remote-port-link';
import { directReasonText, type Translate } from '../connection-status';

/** 那台机器上的网页取不到时,页里显示的那一句(主进程的预览协议 ❌ 自己拼用户文案)。 */
export function remotePageFailureCopy(device: string): { unavailable: string; outside: string } {
  return {
    unavailable: translateSessionMessage('remoteWorkspace.pageUnavailable', { device }),
    outside: translateSessionMessage('remoteWorkspace.pageOutsideFolder', { device }),
  };
}

/** 端口转发失败时,加载失败页上那一句:「没能打开 X 上的 N 端口。」+ 原因码对应的那一句人话。 */
export function remotePortFailureText(reason: RemotePortReason, port: number, device: string, translate: Translate): string {
  const why =
    reason === 'not-direct'
      ? translate('remoteWorkspace.forwardNotDirect', { device })
      : reason === 'forward-refused'
        ? translate('remoteWorkspace.forwardRefused', { device })
        : reason === 'local-port-busy'
          ? translate('remotePorts.localPortBusy', { port })
          : directReasonText(reason, device, translate);
  const headline = translate('remoteWorkspace.forwardFailed', { port, device });
  // 中文句号后不留空格,英文句点后留一个。
  return why ? `${headline}${/[。！？]$/.test(headline) ? '' : ' '}${why}` : headline;
}
