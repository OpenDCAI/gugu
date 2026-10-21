#!/usr/bin/env node
// 把每个架构各自出的 nextmind-mac.yml(#7394 前是 latest-mac.yml)合成一份双架构 feed（#5700）。
//
// 为什么需要它：mac 的两个架构从 2026-09-16 起分成两个并行 job 打（每次公证要等苹果 10 分钟起、
// 实测最坏 74 分钟，串行等两次是整条发布关键路径上最大的一块空转）。而 electron-builder 每次调用
// 只写自己那个架构的 feed —— 客户端读的却必须是**一份**含两个架构的清单。
//
// ❌ 不在这里做「有什么算什么」的宽容合并：少一个架构 = 那批用户从 feed 上掉队（#3128 的形状），
// 多一个 = 把没人测过的架构塞给客户端。所以本脚本只负责拼，严格判据仍由
// scripts/normalize-mac-feed.cjs 在合并结果上执行（恰好一个 -x64.dmg + 一个 -arm64.dmg）。
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

function readFeed(feedPath) {
  const feed = YAML.parse(fs.readFileSync(feedPath, 'utf8'));
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    throw new Error(`${feedPath} must contain a YAML mapping`);
  }
  if (typeof feed.version !== 'string' || feed.version.length === 0) {
    throw new Error(`${feedPath} is missing version`);
  }
  if (!Array.isArray(feed.files) || feed.files.length === 0) {
    throw new Error(`${feedPath} is missing files`);
  }
  return feed;
}

function mergeMacFeeds(feedPaths) {
  if (feedPaths.length < 2) {
    throw new Error(`merge needs at least two feeds, got ${feedPaths.length}`);
  }
  const feeds = feedPaths.map(readFeed);

  // 版本不一致 = 两个 job 打的不是同一棵树（或有人重跑了其中一个 arch）。合出来的 feed 会让
  // 客户端下到跨版本的两半，必须当场炸。
  const versions = [...new Set(feeds.map((f) => f.version))];
  if (versions.length !== 1) {
    throw new Error(`feeds disagree on version: ${versions.join(' vs ')}`);
  }

  const files = [];
  for (const feed of feeds) {
    for (const file of feed.files) {
      if (files.some((seen) => seen.url === file.url)) {
        throw new Error(`duplicate file '${file.url}' across feeds — two jobs produced the same artifact`);
      }
      files.push(file);
    }
  }

  // releaseDate 取最晚的一条：它是「这批包什么时候出的」，两个 arch 各写各的时间戳。
  const releaseDates = feeds.map((f) => f.releaseDate).filter((d) => typeof d === 'string');
  const merged = { version: versions[0], files };
  if (releaseDates.length > 0) {
    merged.releaseDate = releaseDates.sort()[releaseDates.length - 1];
  }
  // 顶层 path/sha512 是 electron-builder 留下的旧字段，保留第一份的，交给 normalize-mac-feed.cjs
  // 去核对它确实指向 files 里的某一条、再删掉 —— 判据留在原处，这里不另起一套。
  if (Object.hasOwn(feeds[0], 'path') && Object.hasOwn(feeds[0], 'sha512')) {
    merged.path = feeds[0].path;
    merged.sha512 = feeds[0].sha512;
  }
  return merged;
}

function mergeMacFeedsToFile(outPath, feedPaths) {
  const merged = mergeMacFeeds(feedPaths);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, YAML.stringify(merged, { lineWidth: 0 }));
  return merged;
}

if (require.main === module) {
  const [outPath, ...feedPaths] = process.argv.slice(2);
  if (!outPath || feedPaths.length < 2) {
    throw new Error('usage: node scripts/merge-mac-feeds.cjs <out/nextmind-mac.yml> <arch-a.yml> <arch-b.yml> [...]');
  }
  const merged = mergeMacFeedsToFile(outPath, feedPaths);
  console.log(`merged ${feedPaths.length} feeds into ${outPath}: ${merged.files.map((f) => f.url).join(', ')}`);
}

module.exports = { mergeMacFeeds, mergeMacFeedsToFile };
