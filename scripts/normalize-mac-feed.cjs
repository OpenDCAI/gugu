#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

// 每条通道各自出哪些架构 —— 这里是**唯一**的声明处，不再全局写死一份。
// @@@5737 起 beta 也有自己的 feed(beta 追 beta,见 apps/desktop/electron/updateFeeds.ts),
// 但它只出 arm64:dogfood 的机器全是 M 芯片,x64 没人装。
// 这张表必须和各自 workflow 里 electron-builder 的 --x64/--arm64 参数一致
// (正式 cd-release.yml,beta beta-dogfood.yml),由 tests/unit/scripts/normalizeMacFeed2750.test.ts 的
// 漂移判据钉住:#3128 就是只改了 workflow、漏了这里,于是构建打完就抛
// "must contain exactly one -x64.dmg file (found 0)"。
// 两处各自写死、彼此不相连 = 改一处另一处不会红,所以补了那条把二者绑起来的判据。
const MAC_FEED_ARCHES = new Map([
  ['nextmind-mac.yml', ['x64', 'arm64']],
  ['nextmind-beta-mac.yml', ['arm64']],
]);

// @@@7394 Mac 换了应用标识(com.gugu.app → nextmind.gugu)。上面两份是**新标识的包**读的清单(electron-builder
// 按 tier.macChannel 写出,带 zip,原地静默更新)。换标识前的老包还读原来那两份 —— 它们照发同一个版本,
// 但**只列 dmg**:老包的 Squirrel 过不了新包的签名判据(钉着标识),有 zip 就会去试一次注定失败的原地换;
// 没有 zip,v0.2.17 起每个老包都会走「下 dmg、打开、请用户拖装」那条路,一次换过去。
// 老清单只由这里从新清单派生(normalizeMacFeedFile 一次写出两份),❌ 单独生成 —— 两份对不上版本,
// 老用户就停在旧版或被指向别的包。
const LEGACY_MAC_FEEDS = new Map([
  ['latest-mac.yml', 'nextmind-mac.yml'],
  ['beta-mac.yml', 'nextmind-beta-mac.yml'],
]);

function requireMacFeedName(feedName) {
  if (!MAC_FEED_ARCHES.has(feedName) && !LEGACY_MAC_FEEDS.has(feedName)) {
    throw new Error(
      `refusing to normalize '${feedName}'; expected one of: ${[...MAC_FEED_ARCHES.keys(), ...LEGACY_MAC_FEEDS.keys()].join(', ')}`
    );
  }
  return feedName;
}

function archesOf(feedName) {
  return MAC_FEED_ARCHES.get(LEGACY_MAC_FEEDS.get(feedName) ?? feedName);
}

function parseMacFeed(source, feedName) {
  requireMacFeedName(feedName);
  const feed = YAML.parse(source);
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    throw new Error(`${feedName} must contain a YAML mapping`);
  }
  if (typeof feed.version !== 'string' || feed.version.length === 0) {
    throw new Error(`${feedName} is missing version`);
  }
  if (!Array.isArray(feed.files) || feed.files.length === 0) {
    throw new Error(`${feedName} is missing files`);
  }

  for (const file of feed.files) {
    if (!file || typeof file.url !== 'string' || typeof file.sha512 !== 'string' || file.sha512.length === 0) {
      throw new Error(`every ${feedName} file must have url and sha512`);
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`${feedName} file '${file.url}' must have a positive integer size`);
    }
  }

  const expectedArches = archesOf(feedName);
  for (const arch of expectedArches) {
    const matches = feed.files.filter((file) => file.url.endsWith(`-${arch}.dmg`));
    if (matches.length !== 1) {
      throw new Error(`${feedName} must contain exactly one -${arch}.dmg file (found ${matches.length})`);
    }
  }
  // 双向卡:少一个架构固然要拦,**多一个也拦**。否则这道闸退化成「有什么算什么」——
  // 一个没人测过、没人打算发的架构会被静默塞进 feed,客户端照样会去下它。
  const dmgs = feed.files.filter((file) => file.url.endsWith('.dmg'));
  if (dmgs.length !== expectedArches.length) {
    throw new Error(
      `${feedName} must contain exactly ${expectedArches.length} dmg file(s) for [${expectedArches.join(', ')}] ` +
        `(found ${dmgs.length}: ${dmgs.map((file) => file.url).join(', ')})`,
    );
  }
  // @@@7394 老清单反过来:**一个 zip 都不许有**。有 zip,老包里已签 Developer ID 的那批会走 Squirrel 原地换,
  // 而它过不了新标识的签名判据 —— 静默失败,用户永远停在旧版。
  if (LEGACY_MAC_FEEDS.has(feedName)) {
    const zips = feed.files.filter((file) => file.url.endsWith('.zip'));
    if (zips.length !== 0) {
      throw new Error(
        `${feedName} is the pre-#7394 feed and must list no zip (found ${zips.length}: ${zips.map((file) => file.url).join(', ')})`
      );
    }
    return feed;
  }
  // @@@5576 zip 同样逐架构双向卡。它比 dmg 更要卡:dmg 缺了用户还能自己下,zip 缺了是
  // electron-updater 在 mac 上唯一能下的形态(MacUpdater 只 findFile(files,'zip'),缺了就抛
  // ERR_UPDATER_ZIP_FILE_NOT_FOUND)——那条错发生在用户机器上,发布这边一声不响。
  // 名字必须带架构:findFile 挑的是 url 里含 process.arch 的那个,同名无架构的两个 zip 会选错。
  for (const arch of expectedArches) {
    const matches = feed.files.filter((file) => file.url.endsWith(`-${arch}.zip`));
    if (matches.length !== 1) {
      throw new Error(`${feedName} must contain exactly one -${arch}.zip file (found ${matches.length})`);
    }
  }
  const zips = feed.files.filter((file) => file.url.endsWith('.zip'));
  if (zips.length !== expectedArches.length) {
    throw new Error(
      `${feedName} must contain exactly ${expectedArches.length} zip file(s) for [${expectedArches.join(', ')}] ` +
        `(found ${zips.length}: ${zips.map((file) => file.url).join(', ')})`,
    );
  }
  return feed;
}

function assertNormalizedMacFeed(source, feedName) {
  const feed = parseMacFeed(source, feedName);
  if (Object.hasOwn(feed, 'path') || Object.hasOwn(feed, 'sha512')) {
    throw new Error(
      `${feedName} still has deprecated top-level path/sha512; run scripts/normalize-mac-feed.cjs after electron-builder`,
    );
  }
  return feed;
}

function assertNormalizedMacFeedVersion(source, feedName, version) {
  const feed = assertNormalizedMacFeed(source, feedName);
  if (feed.version !== version) {
    throw new Error(
      `release/${feedName} version '${feed.version}' != package.json version '${version}' — stale feed file, rebuild first`,
    );
  }
  return feed;
}

function normalizeMacFeedText(source, feedName) {
  const feed = parseMacFeed(source, feedName);
  const hasPath = Object.hasOwn(feed, 'path');
  const hasSha512 = Object.hasOwn(feed, 'sha512');
  if (hasPath !== hasSha512) {
    throw new Error(`${feedName} top-level path and sha512 must either both exist or both be absent`);
  }

  if (hasPath) {
    const selectedFile = feed.files.find((file) => file.url === feed.path);
    if (!selectedFile || selectedFile.sha512 !== feed.sha512) {
      throw new Error(`${feedName} top-level path/sha512 do not match one files entry`);
    }
    delete feed.path;
    delete feed.sha512;
  }

  return YAML.stringify(feed, { lineWidth: 0 });
}

/** 新清单 → 老清单:同一个版本,只留 dmg(见 LEGACY_MAC_FEEDS 的注释)。输入须是修整过的新清单。 */
function legacyMacFeedText(normalizedSource, feedName) {
  const legacyName = [...LEGACY_MAC_FEEDS].find(([, from]) => from === feedName)?.[0];
  if (!legacyName) throw new Error(`'${feedName}' has no pre-#7394 feed to derive`);
  const feed = assertNormalizedMacFeed(normalizedSource, feedName);
  const legacy = { ...feed, files: feed.files.filter((file) => file.url.endsWith('.dmg')) };
  const text = YAML.stringify(legacy, { lineWidth: 0 });
  assertNormalizedMacFeed(text, legacyName);
  return { legacyName, text };
}

/** 修整新清单,并在同一目录写出由它派生的老清单。返回修整后的新清单正文。 */
function normalizeMacFeedFile(feedPath) {
  const feedName = path.basename(feedPath);
  if (!MAC_FEED_ARCHES.has(feedName)) {
    throw new Error(
      `refusing to normalize '${feedName}'; expected one of: ${[...MAC_FEED_ARCHES.keys()].join(', ')} ` +
        '(the pre-#7394 feeds are derived from these, never normalized on their own)'
    );
  }
  const normalized = normalizeMacFeedText(fs.readFileSync(feedPath, 'utf8'), feedName);
  const { legacyName, text } = legacyMacFeedText(normalized, feedName);
  fs.writeFileSync(feedPath, normalized);
  fs.writeFileSync(path.join(path.dirname(feedPath), legacyName), text);
  return normalized;
}

if (require.main === module) {
  const feedPath = process.argv[2];
  if (!feedPath || process.argv.length !== 3) {
    throw new Error('usage: node scripts/normalize-mac-feed.cjs <path/to/nextmind-mac.yml | nextmind-beta-mac.yml>');
  }
  normalizeMacFeedFile(feedPath);
  console.log(`normalized ${feedPath}: files is authoritative; removed deprecated top-level path/sha512; wrote its dmg-only pre-#7394 feed`);
}

module.exports = {
  MAC_FEED_ARCHES,
  LEGACY_MAC_FEEDS,
  legacyMacFeedText,
  assertNormalizedMacFeed,
  assertNormalizedMacFeedVersion,
  normalizeMacFeedFile,
  normalizeMacFeedText,
};
