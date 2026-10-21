import { ExtensionsSettingsCard } from '@renderer/features/settings/components/ExtensionsSettingsCard';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useLibraryHost } from './library-host';

/**
 * 扩展这一页归资源库(owner 2026-09-15:「扩展按理说应该也在资源库中」)。
 * 自己一个文件:资源库去 import 设置页那棵树会把整份 SettingsPage 拖进来。
 *
 * #6264 资源库看的是别的机器时:同一张卡片,列 / 开关 / 权限 / 卸载 / 从市场装都是那台机器上的(那台机器自己的窗口跟着补上 /
 * 撤下 tab)。咕咕 server 也是(161 10-15:server 照样装 App,agent 在它上面装的,人也要能在这里看到、卸掉);它没有窗口,
 * 装在上面的 App 页面打不开、只有工具和技能给那台上的 agent 用 —— 卡片上头如实说这一句。
 */
export function ExtensionsLibraryPage() {
  const { translate } = useSessionMessages();
  const { remote } = useLibraryHost();
  // 页头(名字、一句话、搜索)由那张卡片自己画:点进一个 App 的产品页时整栏换成那一页,页头跟着让开(#7059)。
  if (remote?.hostKind !== 'server') return <ExtensionsSettingsCard />;
  return (
    <div className="space-y-3">
      <p className="m-0 px-3 pt-3 text-sm text-foreground-muted" data-testid="extensions-on-server">
        {translate('deviceScope.extensionsOnServer', { device: remote.deviceLabel })}
      </p>
      <ExtensionsSettingsCard />
    </div>
  );
}
