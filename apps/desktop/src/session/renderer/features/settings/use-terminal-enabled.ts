import { useQuery } from '@tanstack/react-query';
import { observable, runInAction } from 'mobx';
import { queryClient } from '@renderer/lib/query-client';
import {
  APP_SETTINGS_STALE_TIME_MS,
  appSettingsMetaQueryKey,
  getAppSettingValueSnapshot,
  prefetchAppSettingsKey,
  requestAppSettingsMeta,
  type SettingsMeta,
} from './app-settings-client';

/**
 * 设置 → 通用里的「终端」开关(本机的 `terminal.enabled`)。关着:终端的入口与界面一律不出现,新会话走通用;
 * 开着:显示手动切换入口;新会话仍默认通用。只管人看不看得到终端 —— ❌ 拿它去拦 agent 自己的 pty 会话。
 * 读的永远是**本机**这一份(❌ 走 useSettingsHost:机器设置页选了别的机器时,这里仍说本机给不给人看终端)。
 * 还没读到 / 还没定值都按关算。
 */
export function useTerminalEnabled(): boolean {
  const { data } = useQuery<SettingsMeta<'terminal'>>({
    queryKey: appSettingsMetaQueryKey('terminal'),
    queryFn: () => requestAppSettingsMeta('terminal'),
    staleTime: APP_SETTINGS_STALE_TIME_MS,
  }, queryClient);
  return data?.value.enabled === true;
}

// 同一份读数的 MobX 镜像:命令注册表是 @computed,只认 observable —— 开关一拨,命令面板与快捷键跟着变。
const terminalEnabledBox = observable.box(false);
let mirrorInstalled = false;

function installMirror(): void {
  if (mirrorInstalled) return;
  mirrorInstalled = true;
  const key = JSON.stringify(appSettingsMetaQueryKey('terminal'));
  const sync = () =>
    runInAction(() => terminalEnabledBox.set(getAppSettingValueSnapshot('terminal')?.enabled === true));
  queryClient.getQueryCache().subscribe((event) => {
    if (JSON.stringify(event.query.queryKey) === key) sync();
  });
  sync();
  void prefetchAppSettingsKey('terminal');
}

/** 非 React 版本(命令注册表等 MobX 计算里读);还没读到按关算。 */
export function terminalEnabledSnapshot(): boolean {
  installMirror();
  return terminalEnabledBox.get();
}
