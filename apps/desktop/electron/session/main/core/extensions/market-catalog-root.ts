import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAppVersion } from '@main/core/app/utils';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { currentMarketHost } from '@shared/extensions/market';
import { marketRefreshedChannel } from '@shared/extensions/marketEvents';
import type { MarketSnapshotStore } from '@shared/extensions/market-snapshot';
import feeds from '../../../../updateFeeds.json';
import { DownloadSiteMarketBackend } from './download-site';
import { CloudExtensionMarket } from './market-catalog';

/*
 * App 市场在这台机器上怎么接线:下载站的 `market/` 根(地址与更新 feed 同在 updateFeeds.json)。
 *
 * `market-catalog.ts` 本身不 import electron,于是下载/校验/解包可以对着临时目录判 ——
 * 这里是唯一碰 electron 的地方;读下载站的是 download-site.ts。下载站是公开的,市场不要登录。
 */

/**
 * 手上那份目录落在 userData 里的一个文件:下次启动打开 App 页先画它(market-snapshot.ts)。先写到旁边再换名 ——
 * 写到一半退出的那份不会被读成目录。读不到、写不进只进日志:没有它只是这次要等一趟下载站。
 */
function snapshotFileStore(file: string): MarketSnapshotStore {
  return {
    read: async () => {
      try {
        return await fs.promises.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('The kept App market index could not be read:', error);
        return null;
      }
    },
    write: async (text) => {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(`${file}.next`, text, 'utf8');
        await fs.promises.rename(`${file}.next`, file);
      } catch (error) {
        log.warn('The App market index could not be kept:', error);
      }
    },
  };
}

let market: CloudExtensionMarket | null = null;

/**
 * 解包落在 userData 下自己的目录里,而不是系统临时目录:安装要读它,而 macOS 的
 * `/tmp` 会被系统按自己的节奏清 —— 一个正在等用户点头的包被清掉,安装会以
 * 「文件夹不见了」失败,而用户什么都没做错。
 */
function marketDir(): string {
  return path.join(app.getPath('userData'), 'extension-market');
}

/**
 * 下载站的 `market/` 根。开发形态(没打包)可以用 `GUGU_MARKET_BASE` 指到一份本地测试市场(#7059:线上市场还是空的,
 * 改版要对着真有 App 的一份看);打包出去的咕咕只认 updateFeeds.json 那一个地址。
 */
function marketBase(): string {
  const override = process.env.GUGU_MARKET_BASE?.trim();
  if (override && !app.isPackaged) return override.endsWith('/') ? override : `${override}/`;
  return feeds.market;
}

export function cloudExtensionMarket(): CloudExtensionMarket {
  if (!market) {
    const base = marketBase();
    market = new CloudExtensionMarket(new DownloadSiteMarketBackend(base), {
      stagingRoot: path.join(marketDir(), 'staging'),
      heldRoot: path.join(marketDir(), 'held'),
      resolveHost: async () => currentMarketHost(await resolveAppVersion(), 'desktop'),
      snapshotStore: snapshotFileStore(path.join(marketDir(), 'index-snapshot.json')),
      scope: base,
      onRefreshFailure: (error) => log.warn('App market index not refreshed; the one in hand stays:', error),
    });
    // 上一次运行留着、没等到点头的那几份,在这一次第一次用市场时扫掉。
    market.sweepHeld();
    // 每一趟取目录的结果都告诉界面(打开页面那一趟、安装时现取的那一趟):变了,市场页和更新检查一起重读。
    market.onRefreshed((refreshed) => events.emit(marketRefreshedChannel, refreshed));
  }
  return market;
}
