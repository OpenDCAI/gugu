import { describe, expect, it } from 'vitest';
import { provider } from './index';
import { codexPlatformProviderConfigArgs } from './platform-provider-args';

/**
 * #6264 d22 实机两条:
 *  ① 咕咕额度的会话开头甩一整段 `codex_apps … 401 token_expired` —— ChatGPT Apps 连接器只认用户自己的
 *    ChatGPT 登录,这类会话根本不该起它(官方开关 `features.apps`)。
 *  ② 模型目录探针让 codex 把 `[projects."/tmp/gugu-model-probe-codex-…"]` 一条条写进用户的 config.toml。
 */
// 桥入口由宿主按 `acp.bridge` 声明解析好递进来(#6394);codex 只认咕咕自己的 app-server 桥。
const BRIDGE = '/x/gugu-codex-app-server-acp.mjs';

const PLATFORM = {
  providerId: 'gugu_platform',
  providerLabel: 'Gugu 平台额度',
  baseUrl: 'http://127.0.0.1:1/relay/v1',
  model: 'gpt-5.6-luna',
  apiKey: 'k',
  spawnEnv: {},
};

function spawn(platform?: typeof PLATFORM, adapterEntry: string | null = BRIDGE) {
  return provider.behavior.acp!.buildSpawn({
    cwd: '/tmp/gugu-model-probe-codex-AbC123',
    env: { GUGU_CODEX_BIN: '/x/codex' },
    cli: 'codex',
    ...(adapterEntry ? { adapterEntry } : {}),
    ...(platform ? { platform } : {}),
  });
}

describe('#6264 咕咕额度的 codex 会话不起 ChatGPT Apps 连接器', () => {
  it('平台 provider 声明里带 features.apps=false', () => {
    expect(codexPlatformProviderConfigArgs({ providerId: 'p', providerName: 'n', baseUrl: 'u' }))
      .toEqual([
        '-c', 'model_provider=p',
        '-c', 'model_providers.p.name="n"',
        '-c', 'model_providers.p.base_url="u"',
        '-c', 'model_providers.p.env_key=OPENAI_API_KEY',
        '-c', 'model_providers.p.wire_api=responses',
        '-c', 'features.apps=false',
      ]);
  });

  it('聊天会话:平台会话的 app-server argv 关掉 apps;自家账号的会话不动(codex 行为原样)', () => {
    expect(spawn(PLATFORM).args).toContain('features.apps=false');
    expect(spawn().args).not.toContain('features.apps=false');
  });
});

describe('#6264 工作目录的信任按次给,❌ 让 codex 写进用户的 config.toml', () => {
  it('咕咕的桥(聊天会话与模型目录探针同一条起法)带上 cwd 的按次信任', () => {
    const { args } = spawn();
    // 内联表写法:codex 把 `-c` 的键按 `.` 裸切,点路径写法 `projects."<cwd>".trust_level` 等于没给。
    const at = args.indexOf('projects={ "/tmp/gugu-model-probe-codex-AbC123" = { trust_level = "trusted" } }');
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe('-c');
  });

  // 阴控:没有桥入口就当场报错,❌ 回落到不认这条 argv 的上游 codex-acp(#6394 已移除)。
  it('宿主没递桥入口 ⇒ 当场报错,不会把这条 argv 递给别的桥', () => {
    expect(() => spawn(undefined, null)).toThrow(/adapterEntry/);
  });
});
