#!/usr/bin/env node
// @@@5790 把各平台的片段合成下载站的总清单 releases/latest.json。
//
// 为什么要单独一个脚本(原因):publish-oss-release.cjs 在四个平台 job 里各跑一次,每次只看得见
// 自己那台机器上的产物,所以它**描述不了整个 release**。从前它照样写全局 latest.json,于是四个
// job 依次覆盖同一个对象、最后收尾的平台通吃 —— v0.2.44 实测总清单只剩 ["mac"],而四个平台的
// 产物其实都在 OSS 上。缺的只有清单里的条目,且全程零信号。
//
// 这里反过来:输入是**已经发布到 OSS 上的事实**(各平台的 manifest.json 片段),由一个 needs 了
// 全部出货 job 的独立 job 调用 —— 输入完整由 needs 保证,不再依赖谁跑得慢。
//
//   node scripts/aggregate-release-manifest.cjs --expect mac,windows,android,linux
//   node scripts/aggregate-release-manifest.cjs --expect mac,linux --dry-run
//
// --expect 是**声明**:这次发布应该有哪几个平台。少一个就 fail loud 并点名是谁 —— 一个平台
// 构建失败却让总清单悄悄少一格,正是本 issue 要根除的那种静默半残。
const fs = require('node:fs/promises');
const path = require('node:path');
const OSS = require('ali-oss');

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release');
const downloadBaseUrl =
  process.env.GUGU_DOWNLOAD_BASE_URL || 'https://download.gugu.nextmind.space';
const dryRun = process.argv.includes('--dry-run');
// CDN 传播宽限(ms);单测置 0 提速,与 publish-oss-release.cjs 的 #2122 自校验同口径。
const READBACK_RETRY_MS = Number(process.env.GUGU_FEED_VERIFY_RETRY_MS ?? 3000);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** --expect mac,windows,android,linux → ['mac','windows','android','linux'] */
function parseExpected(argv) {
  const at = argv.indexOf('--expect');
  const raw = at === -1 ? '' : (argv[at + 1] ?? '');
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) {
    throw new Error(
      '缺 --expect:必须显式声明这次发布应该有哪几个平台(例:--expect mac,windows,android,linux)。' +
        '❌ 不从"OSS 上碰巧有什么"反推 —— 那样一个平台没出包就会被悄悄接受。',
    );
  }
  return list;
}

/**
 * 合并各平台片段成总清单。纯函数,便于单测直接钉住形状与顺序。
 * 顺序按 expected 给的顺序,而不是读回来的先后 —— 清单是给人看的,顺序不该随并发抖动。
 */
function buildManifest({ productName, version, releaseDate, expected, fragments }) {
  const missing = expected.filter((p) => !fragments.has(p));
  if (missing.length > 0) {
    throw new Error(
      `这些平台在 releases/<平台>/${version}/manifest.json 上找不到片段:${missing.join(', ')}。` +
        '要么那个平台的 publish 没跑成,要么它没写片段 —— 两种都不该让总清单少一格就发出去。',
    );
  }
  for (const p of expected) {
    const fragment = fragments.get(p);
    if (fragment.version !== version) {
      throw new Error(
        `${p} 的片段写的是 ${fragment.version},与本次发布的 ${version} 对不上 —— ` +
          '多半是上一版残留的对象,不能拿它充数。',
      );
    }
    if (fragment.platform?.platform !== p) {
      throw new Error(`${p} 的片段里 platform 字段是 ${fragment.platform?.platform},对不上。`);
    }
  }
  return {
    name: 'gugu',
    productName,
    version,
    releaseDate,
    platforms: expected.map((p) => fragments.get(p).platform),
  };
}

async function readFragment(client, platform, version) {
  const key = `releases/${platform}/${version}/manifest.json`;
  try {
    const res = await client.get(key);
    return JSON.parse(res.content.toString('utf8'));
  } catch (error) {
    const reason = error && error.status === 404 ? '不存在(404)' : (error?.message ?? String(error));
    throw new Error(`取 ${key} 失败:${reason}`);
  }
}

/**
 * 回读:传上去不等于取得到,更不等于内容对。
 * 判据必须能判定**这次发布承诺的那件事** —— 版本号对、声明的平台一个不少。
 * ❌ 不是"能解析"或"platforms 非空":v0.2.44 那次总清单只剩一个平台,这两个判据都照样通过。
 */
async function verifyLive(version, expected) {
  const url = `${downloadBaseUrl}/releases/latest.json`;
  let detail = 'no attempt';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, READBACK_RETRY_MS));
    try {
      // 带一个时间戳绕开边缘缓存,否则回读的可能是上一版那份总清单。
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) {
        detail = `HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      const got = (json.platforms ?? []).map((p) => p.platform);
      const missing = expected.filter((p) => !got.includes(p));
      if (json.version !== version) {
        detail = `总清单报的是 ${json.version},期望 ${version}`;
        continue;
      }
      if (missing.length > 0) {
        detail = `总清单缺这些平台:${missing.join(', ')}(现有:${got.join(', ') || '空'})`;
        continue;
      }
      console.log(`总清单已生效:version=${json.version} platforms=${got.join(', ')}`);
      return;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`总清单回读失败:${url} → ${detail}`);
}

async function main() {
  const { readScriptEnv } = require('./build-env-preflight.mjs');
  for (const [key, value] of Object.entries(readScriptEnv(rootDir))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const expected = parseExpected(process.argv);
  const pkg = require(path.join(rootDir, 'package.json'));
  const version = pkg.version;

  if (dryRun) {
    console.log(`[dry-run] 会合成 ${version} 的总清单,期望平台:${expected.join(', ')}`);
    return;
  }

  for (const name of ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_OSS_BUCKET', 'ALIYUN_OSS_REGION']) {
    requireEnv(name);
  }

  const client = new OSS({
    region: requireEnv('ALIYUN_OSS_REGION'),
    accessKeyId: requireEnv('ALIYUN_ACCESS_KEY_ID'),
    accessKeySecret: requireEnv('ALIYUN_ACCESS_KEY_SECRET'),
    stsToken: process.env.ALIYUN_OSS_STS_TOKEN,
    bucket: requireEnv('ALIYUN_OSS_BUCKET'),
    timeout: 1200000,
    secure: true,
  });

  const fragments = new Map();
  for (const platform of expected) {
    fragments.set(platform, await readFragment(client, platform, version));
    console.log(`片段已读回:${platform}`);
  }

  const manifest = buildManifest({
    productName: pkg.productName,
    version,
    releaseDate: new Date().toISOString(),
    expected,
    fragments,
  });

  await fs.mkdir(releaseDir, { recursive: true });
  const outPath = path.join(releaseDir, 'latest.json');
  await fs.writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  };
  const body = await fs.readFile(outPath);
  await client.put('releases/latest.json', body, { headers });
  console.log('uploaded releases/latest.json');
  for (const platform of expected) {
    await client.put(`releases/${platform}/latest/latest.json`, body, { headers });
    console.log(`uploaded releases/${platform}/latest/latest.json`);
  }

  await verifyLive(version, expected);
  console.log(`${downloadBaseUrl}/releases/latest.json`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildManifest, parseExpected, verifyLive, readFragment };
