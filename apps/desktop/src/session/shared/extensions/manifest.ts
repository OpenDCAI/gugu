import { z } from 'zod';
import { EXTENSION_API_VERSION } from './bridge-protocol';
import { networkHostAllowed } from './partition';
import { APP_PLATFORMS } from './app-platforms';

/**
 * Extension (App) manifest — the `manifest.json` at the root of an
 * extension bundle. Extensions contribute workspace tabs that render inside a
 * sandboxed <webview>. Parsing here grants nothing by itself: every declared
 * permission is enforced by the main process against the parsed result
 * (network allowlist on the extension's session partition, CSP pinning code
 * to the local bundle). Refs #2374.
 */

export { EXTENSION_API_VERSION };
/**
 * The oldest bridge/manifest contract this build still runs. A bundle declaring an
 * `apiVersion` below it needs its author's attention; one above it needs a newer
 * gugu. Both are compatibility facts, not「the bundle is broken」— the market keeps
 * them apart (see shared/extensions/market.ts `compatOf`).
 */
export const EXTENSION_API_VERSION_MIN_SUPPORTED = 3;

// `engines.gugu`: the oldest gugu this bundle runs on, as a lower bound only.
// Same idea as VS Code's `engines.vscode` (`^1.8.0`), narrowed to the two spellings
// whose meaning nobody can misread — the host reads the bound, never a range algebra.
export const ENGINES_RANGE_PATTERN = /^(>=|\^)(\d+\.\d+\.\d+)$/;

// Extension ids may not contain '.' — the tab kind is `<extensionId>.<tabName>`
// and must split back unambiguously.
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TAB_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// A shelf category is a slug, not a label: the host maps known ones to words in
// the user's language and shows an unknown one as-is, so authors can add their
// own without the schema having to know every category first.
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Bare lowercase hostname with at least two labels; leftmost label may be the
// wildcard `*.`. No scheme, port, or path — the manifest names hosts, the
// enforcement layer decides protocols.
const NETWORK_HOST_PATTERN =
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Names for this machine and its neighbours. Label counting alone does not
// exclude them — `127.0.0.1` and `db.localhost` are perfectly well-formed
// two-label names — and reaching local services is not something an extension
// gets to do by declaring a host that happens to point inward. Enforcement
// repeats this per request; a manifest that cannot express it is the first gate.
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.startsWith('[') || host.includes(':')) return true; // IPv6 literal
  if (!IPV4_LITERAL.test(host)) return false;
  // Any IPv4 literal: an extension names hosts, not addresses. Public ones are
  // refused too rather than maintaining a private-range table that a redirect
  // could sidestep anyway.
  return true;
}

// Bundle-relative POSIX path: no absolute paths, no backslashes, no '.'/'..'
// segments, so a manifest can never point outside its own bundle.
function isBundleRelativePath(value: string): boolean {
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const bundlePathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isBundleRelativePath, {
    message: 'must be a bundle-relative path without "..", "." or leading "/"',
  });

// Links the host will draw and open in a browser tab. https only — the same
// reason the network allowlist is https only: a link is a promise about who answers.
const httpsUrlSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an https:// URL' }
  );

/**
 * A thing the extension offers the user inside its own tab.
 *
 * `id` is the extension's own word for it — the host never interprets it, it
 * just hands it back when the user picks it. That is what keeps this
 * declarative: the host owns where it appears, the extension owns what it means.
 */
const tabCommandSchema = z.strictObject({
  id: z.string().regex(TAB_NAME_PATTERN, { message: `must match ${String(TAB_NAME_PATTERN)}` }),
  title: z.string().trim().min(1).max(32),
});

/**
 * A local program this extension runs as an MCP server for the agents on this machine
 * (owner 2026-09-24 chose「扩展可以自带一个本机程序当 MCP server」). It runs with the
 * person's full rights — which is why the install sheet shows the exact command and it
 * sits behind its own consent (`agents:tools`), revocable on its own.
 *
 * `command`: `node` runs on gugu's own runtime (nobody has to install Node); a path
 * starting with `./` is a program inside the bundle; anything else is looked up on PATH
 * (`npx`, `uvx`, `python3`). The working directory is the installed bundle, so bundle
 * files in `args` are plain relative paths.
 */
const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const mcpServerName = z.string().regex(MCP_SERVER_NAME_PATTERN, { message: `must match ${String(MCP_SERVER_NAME_PATTERN)}` });
const mcpServerEnv = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096)).optional();
export const mcpServerContributionSchema = z.union([
  z.strictObject({
    name: mcpServerName,
    // `node`, `./<in-bundle>` or a bare PATH name — ❌ an absolute path or `..`: that names
    // something on this machine the person never saw as part of the extension.
    command: z.string().regex(/^(\.\/(?!.*\.\.)[A-Za-z0-9._/-]+|[A-Za-z0-9][A-Za-z0-9._+-]*)$/, {
      message: 'must be node, ./<path inside the bundle>, or a program name found on PATH',
    }),
    args: z.array(z.string().max(1024)).max(32).optional(),
    env: mcpServerEnv,
  }),
  /*
   * 摩擦单 F77 A module of the bundle whose every export is an MCP tool (the Tool's fields plus `run(args, { agent })`):
   * gugu runs it on its own runtime and speaks MCP for it — the App writes its tools, never the protocol, and who called
   * comes from gugu's gateway alone (app-runtime/tools-host.ts). The same consent as a command: it runs on this computer
   * with the person's rights. No name (摩擦单 F119): it is the App's, and its tools are `<App id>__<tool>`.
   */
  z.strictObject({
    tools: z.string().regex(/^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._/-]*\.m?js$/, {
      message: 'must be a .js or .mjs file inside the bundle, like "tools.js"',
    }),
    env: mcpServerEnv,
  }),
  /** Native resources stay in the host; the App owns their install, consent and agent scope. */
  z.strictObject({ name: mcpServerName, host: z.enum(['browser-use', 'computer-use']) }),
  // L11 R9: two strict shapes fail as one "Invalid input" — say both, and why a tools module has no name.
], { error: 'a program is {"tools":"tools.js"} (no name: it is the App\'s) or {"name","command","args"?}' });

const CLAIMED_SUFFIX = /^\.[a-z0-9][a-z0-9.+-]*$/;
const CLAIMED_NAME = /^[a-z0-9_*+-][a-z0-9._*+ -]{0,127}$/;

/**
 * One thing a tab claims (`opensFiles`), lowercased — a claim matches whatever the case on disk:
 * - a suffix, dot-led: `.csv`, `.vote.json` (the longer one wins);
 * - a file name (摩擦单 F82): `todo.md`, or with `*` for any run of characters, `todo-*.md` — more specific than
 *   any suffix, so an App can take one file of a repository without taking every `.md`. `*.x` IS the suffix `.x`:
 *   written as the suffix.
 */
const fileClaimSchema = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((claim, ctx) => {
    if (claim.startsWith('.')) {
      if (!CLAIMED_SUFFIX.test(claim)) ctx.addIssue({ code: 'custom', message: 'must be a dot-led lowercase suffix like ".csv"' });
      return;
    }
    if (!CLAIMED_NAME.test(claim)) {
      ctx.addIssue({ code: 'custom', message: 'a file name like "todo.md" or "todo-*.md": letters, digits, space, . _ - + and *, no slashes' });
    } else if (/^[a-z0-9]{1,5}$/.test(claim)) {
      // `md`, `csv`: a suffix missing its dot far more often than a file named so — said, not taken as a name.
      ctx.addIssue({ code: 'custom', message: `"${claim}" needs its dot: a dot-led lowercase suffix, like ".${claim}"` });
    } else if (/^\*+\.[a-z0-9][a-z0-9.+-]*$/.test(claim)) {
      ctx.addIssue({ code: 'custom', message: `"${claim}" is the suffix "${claim.replace(/^\*+/, '')}": write the suffix` });
    } else if (!/[^*]/.test(claim)) {
      ctx.addIssue({ code: 'custom', message: 'a file name needs more than "*"' });
    }
  });

/** What a tab claims in one context (`opensFiles`): suffixes and file names, at most 16. */
const fileSuffixesSchema = z.array(fileClaimSchema).min(1).max(16);

/**
 * A tab's `opensFiles`, by context: `{ session?, chat? }` — files of a session's working copy, files of a chat's
 * workspace (a group's, a topic's or a private chat's: 主人 10-05「私聊也是得有面板的」). The one form (apiVersion 2
 * dropped the plain list, which meant a task's files: 摩擦单 F110, an agent wanting two files of its group wrote a plain
 * list and the App also claimed working-copy files it never meant). Any other shape or key is refused naming the two
 * there are — no table from an old key to a new one (owner 10-06). Read claims through `claimedSuffixes`.
 */
export const opensFilesSchema = z
  .strictObject(
    { session: fileSuffixesSchema.optional(), chat: fileSuffixesSchema.optional() },
    { error: 'say where the files are: {"session":[…]} or {"chat":[…]}' },
  )
  .refine((claims) => claims.session !== undefined || claims.chat !== undefined, {
    message: 'declare the files of at least one context: "session" or "chat"',
  });
export type ExtensionOpensFiles = z.infer<typeof opensFilesSchema>;

const tabContributionSchema = z.strictObject({
  /** Stable machine name; combined with the extension id into the tab kind. */
  name: z.string().regex(TAB_NAME_PATTERN, {
    message: `must match ${String(TAB_NAME_PATTERN)}`,
  }),
  /** Human-facing tab title. */
  title: z.string().trim().min(1).max(48),
  /**
   * The page THIS tab draws. Absent falls back to the manifest's own `entry`.
   *
   * Without it `contributes.tabs` was a promise the host could not keep: it takes
   * 1–8 contributions, but every one of them loaded `manifest.entry` — the same
   * page, with nothing in `getContext()` saying which contribution it was. So a
   * two-tab extension drew the same thing twice, and `gugu_session app_create`,
   * which writes one HTML per tab, left every file after the first unreachable.
   *
   * Optional rather than required because every bundle that exists declares one
   * tab, where the manifest-level entry already says it: making it required would
   * break them all to state something they already state.
   */
  entry: bundlePathSchema.optional(),
  /** A host-owned page; no HTML is loaded from the App for this tab. */
  hostPage: z.literal('settings').optional(),
  /**
   * One page of this tab in each task, belonging to that task for its whole life — the way a group's page belongs to
   * its group (behavior tab-extensions「每个任务一份的页签」, #7317). For a page that shows what happens in one task, like
   * Computer Use's 「电脑」: two tasks side by side each show their own.
   *
   * A page's place, not a data level: what the App keeps, and how it divides it, stays the App's own business.
   */
  perSession: z.literal(true).optional(),
  /**
   * Bundle-relative raster icon for this tab. Optional; without one the tab
   * is drawn with the App's own `icon`, and only with neither the generic mark.
   *
   * The decision this field waited for (host chrome has no `gugu-ext://`
   * handler, and must not draw extension-supplied bytes) is settled by never
   * shipping those bytes: main decodes the file and re-encodes it, so the
   * renderer only ever paints a PNG this process wrote. See
   * `main/core/extensions/extension-icon.ts`.
   *
   * ❌ SVG — a document format with script and external references in it.
   */
  icon: bundlePathSchema.optional(),
  /**
   * The files this tab offers to open (behavior tab-extensions:「认领某类文件的打开方式」), by
   * suffix — lowercase, dot-led — and by where the file lives (真源 §2.4, 主人 09-29):
   *
   * - `{ "session": [".csv"], "chat": [".md", ".json"] }` — each context declared on its own: files in
   *   a session's working copy, files in a chat's workspace. An App shows up in a context's
   *   「打开方式」 only where it said so, like an application on an operating system.
   *
   * A CLAIM, not a takeover. The user's own choice always wins and the built-in
   * editor stays reachable — an extension that could seize a file type could make
   * a file unopenable by installing itself, which is a thing no install should be
   * able to do. Claims are matched case-insensitively because the suffix on disk
   * is not the author's to predict. Read them through `claimedSuffixes`.
   *
   * ❌ globs. A suffix is checkable by reading it; `**\/{a,b}/*.{c,d}` needs a
   * matcher, and the first question a matcher raises is what a claim on
   * `../../etc/*` means. The narrow thing answers the spec's case.
   */
  opensFiles: opensFilesSchema.optional(),
  /**
   * The icon of each kind of file this tab opens, by its claim in `opensFiles`: `{ ".md": "md.png" }` — what a file list
   * draws next to such a file (owner 10-17: a markdown file drawn with the folder App's own icon reads as a folder). The
   * same rules as `icon`: raster, re-encoded by the host. A claim without one is drawn with the host's generic file mark,
   * never the App's icon.
   */
  fileIcons: z.record(z.string().trim().toLowerCase(), bundlePathSchema).optional(),
  /**
   * Entries added to this tab's own right-click menu, after the host's own.
   * Capped because a context menu that scrolls is not a menu.
   */
  menu: z.array(tabCommandSchema).max(8).optional(),
  /**
   * Buttons drawn in this tab's own header strip. Same cap and the same reason:
   * this is the extension's corner of the window, not a place to grow a ribbon.
   */
  toolbar: z.array(tabCommandSchema).max(6).optional(),
});

/**
 * Capabilities an extension asks the host for, beyond drawing its own page.
 *
 * These are the words for the abilities the product already promises a tab
 * extension (product spec). Naming them separately is what makes
 * them separately consentable and separately revocable — a single "can it do
 * host things" flag would mean taking back one ability requires uninstalling.
 *
 * A colon can never appear in a hostname (see NETWORK_HOST_PATTERN), so a
 * capability key and a declared host never collide in the record of what the
 * user took back — no migration, no ambiguity.
 *
 * ❌ No word is listed here before the host can actually enforce it: a declared
 * permission the host ignores is the schema's version of a button that does
 * nothing. Terminal (product spec: 「可以在会话里起终端」) is therefore not here
 * yet — it lands with the verb, not before it.
 */
export const EXTENSION_CAPABILITIES = [
  // The files of any chat the person is in, and of this computer's sessions — wherever the page is (真源原则 13). The file
  // a page was opened for (`ctx.file`) needs neither.
  'files:read',
  // `files:read` reaching the sessions on the person's other machines too, read only: a widened meaning is a new word,
  // as for the agents words below.
  'files:read:all-machines',
  'files:write',
  // A whisper in the person's name in any chat they are in, marked as from this App: `gugu.send`.
  'chat:relay',
  // Which chats the person is in, who is in them, and their messages — only the ones they can see there: `gugu.chats`,
  // `gugu.messages`.
  'chat:read',
  /*
   * Seeing the agents at work (behavior tab-extensions:「agent 的可见与可控」).
   *
   * Scope rides in the word itself rather than a structured field, because the
   * record of what the user took back is one flat set of strings shared with
   * declared hosts — a nested scope would have no place in it, and «revoke the
   * widening but keep the capability» is a thing a user should be able to do.
   *
   * Bare = the agents this App started. `:all` = every agent on this machine.
   * `:all-machines` = every agent on all of the person's machines (read and control only;
   * a word whose meaning is widened is a new word, never the old one stretched — owner 10-05).
   * Each wider word implies the narrower ones: same verb, wider answer. You write more to get
   * more, which is the schema's version of「默认最小、可声明放大」.
   *
   * ❌ 别在这里加宿主还强制不了的词:列出来即等于向用户承诺一道并不存在的闸,
   * 而用户是照着这份清单点的头。每个词都跟着能强制它的那段代码一起落地。
   */
  'agents:read',
  'agents:read:all',
  'agents:read:all-machines',
  // Reading what the agents actually said. Separate from `agents:read` because a
  // status light must not cost the user their conversations.
  'agents:history',
  'agents:history:all',
  // Starting, stopping and speaking to agents. One word for all three: they are
  // the same sentence to the person deciding —「替我操作 agent」—— and splitting
  // them would grow the install list without telling anyone anything new.
  'agents:control',
  'agents:control:all',
  'agents:control:all-machines',
  /*
   * 让 agent 用这个扩展带来的 MCP 程序与 skill(`contributes.mcpServers` / `contributes.skills`)。
   *
   * 是一个能力而不是一个事实:装的时候要说出来(连同要在这台电脑上跑的命令)、事后要能单独
   * 关掉 —— 「这个扩展我要,但别让它在我电脑上跑程序、别给 agent 加东西」是一句用户会说的话。
   * 关掉之后下一条会话起不再注入,扩展本身照常画。声明了 MCP / skill 就必须声明它,反之亦然
   * (superRefine),于是「给 agent 加了东西却没问过用户」在清单层就写不出来。
   */
  'agents:tools',
  // 发系统横幅。横幅是咕咕唯一的提醒通道,扩展借用它就要在装的时候说出来。
  'notifications',
] as const;

export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/** How far an `agents:*` word reaches, narrowest first: the App's own agents, this machine's, all machines'. */
export const AGENT_REACH = ['own', 'all', 'all-machines'] as const;
export type AgentReach = (typeof AGENT_REACH)[number];

/** A word's family (`agents:read`) and its reach (`agents:read:all` → `all`); a word without a reach suffix is `own`. */
export function capabilityReach(word: string): { family: string; reach: AgentReach } {
  for (const reach of ['all-machines', 'all'] as const) {
    if (word.endsWith(`:${reach}`)) return { family: word.slice(0, -(reach.length + 1)), reach };
  }
  return { family: word, reach: 'own' };
}

/** Whether the granted words cover `wanted`: the same family at the same or a wider reach. ❌ 窄的永远不满足宽的。 */
export function capabilityCovered(granted: readonly string[], wanted: string): boolean {
  const want = capabilityReach(wanted);
  return granted.some((word) => {
    const have = capabilityReach(word);
    return have.family === want.family && AGENT_REACH.indexOf(have.reach) >= AGENT_REACH.indexOf(want.reach);
  });
}

/**
 * The granted words with every narrower word they cover (`files:read:all-machines` gives `files:read` too): what the App
 * may do, read once where the grant is read, so a check asking for the narrow word finds it. What the person is shown
 * stays the declared words.
 */
export function withCoveredCapabilities(granted: readonly string[]): ExtensionCapability[] {
  return EXTENSION_CAPABILITIES.filter((word) => capabilityCovered(granted, word));
}

/** The widest reach the granted words give a family (`own` when only the bare word, or none, is granted). */
export function grantedReach(granted: readonly string[], family: string): AgentReach {
  const reaches = new Set(granted.map(capabilityReach).filter((word) => word.family === family).map((word) => word.reach));
  return [...AGENT_REACH].reverse().find((reach) => reaches.has(reach)) ?? 'own';
}

/*
 * ❌ 这里不需要「这个 key 是能力还是主机名」的判定函数:撤销记录是一个扁平集合,
 * 两个读取方各自拿**自己声明过的那份清单**去筛(ExtensionsService 的
 * `allowedNetworkHosts` / `grantedCapabilities`),从来不需要反过来问一个 key 属于哪边。
 * 曾经有过一个 `isExtensionCapability`,导出了、谁也没调用。
 */

const permissionsSchema = z.strictObject({
  /**
   * Abilities this extension asks for. Each is consented to and revoked on its
   * own; revoking one leaves the extension running without that ability.
   *
   * `files:write` does **not** imply `files:read`: an extension that
   * needs both declares both. Implying one from the other would put an ability
   * in the granted set that the user was never shown.
   */
  capabilities: z
    .array(z.enum(EXTENSION_CAPABILITIES))
    .max(12)
    .optional(),
  /** Hostnames this extension's webview may reach. Anything else is blocked. */
  network: z
    .array(
      z
        .string()
        .regex(NETWORK_HOST_PATTERN, {
          message: 'must be a bare lowercase hostname (optional leading "*."), no scheme/port/path',
        })
        .refine((host) => !isLoopbackOrPrivateHost(host.replace(/^\*\./, '')), {
          message: 'must not name this machine or a local network (no IP literals, localhost, .local)',
        })
    )
    .max(16)
    .optional(),
});

export const extensionManifestSchema = z
  .strictObject({
    id: z.string().regex(EXTENSION_ID_PATTERN, {
      message: `must match ${String(EXTENSION_ID_PATTERN)} (no dots — '.' separates id and tab name in tab kinds)`,
    }),
    /** Human-facing extension name. */
    name: z.string().trim().min(1).max(64),
    /** Required when publishing or installing; installed older Apps remain readable at runtime. */
    platforms: z.array(z.enum(APP_PLATFORMS)).optional(),
    /**
     * What it does, for the market card and the detail sheet. Optional: every
     * bundle that exists predates it, and a manifest is not less valid for not
     * selling itself. Capped because a card clamps at three lines — anything a
     * reader has to scroll belongs in the bundle's own page. Refs #5265.
     */
    description: z.string().trim().min(1).max(280).optional(),
    /**
     * 名字下面那一句(市场的行、精选卡的大字、产品页头):这个 App 是什么,一行写得下。没写就用 description 的第一句。
     * 30 字封顶:中文 20 字左右、英文 30 个字符就是一行。写了它就要声明 `apiVersion` 8(下面 superRefine):只认得 7 的客户端
     * (0.2.57-beta.113.1 / 115.1,与新版共用 0.2.57 这个 x.y.z)于是拿到这个 App 给 7 的上一版,❌ 拿到一份它的 schema 拒收的 manifest。
     */
    subtitle: z.string().trim().min(1).max(30).optional(),
    /**
     * 「对 agent 说」(#7059):产品页上一两句示例说法,点一句 = 新建任务、这句已填好。写给人看、照它说给 agent,
     * 所以短;App 自己写,跟代码一起改版本(索引仓只放官方定的事)。用到它的版本要 `engines.gugu >= 0.2.53`。
     */
    examples: z.array(z.string().trim().min(1).max(80)).min(1).max(3).optional(),
    /** Who made it, as shown under the name. Not verified — the host never claims it is. */
    author: z.string().trim().min(1).max(64).optional(),
    /** Shelf categories, as slugs (see CATEGORY_PATTERN). */
    categories: z
      .array(
        z.string().regex(CATEGORY_PATTERN, { message: `must match ${String(CATEGORY_PATTERN)}` })
      )
      .min(1)
      .max(4)
      .optional(),
    version: z.string().regex(VERSION_PATTERN, { message: 'must be a semver core "x.y.z"' }),
    /**
     * Bridge/manifest contract revision. Bump only with a migration story.
     *
     * A range, not a literal: the catalogue now lives in the cloud, so bundles
     * written against a newer or older contract than this build will be seen by
     * it. Which side is wrong matters —「update gugu」and「the author must update
     * this」are different instructions — so each side gets its own sentence.
     */
    apiVersion: z
      .number()
      .int()
      .superRefine((value, ctx) => {
        if (value > EXTENSION_API_VERSION) {
          ctx.addIssue({
            code: 'custom',
            message: `apiVersion ${value} needs a newer gugu (this build supports up to ${EXTENSION_API_VERSION})`,
          });
        } else if (value < EXTENSION_API_VERSION_MIN_SUPPORTED) {
          ctx.addIssue({
            code: 'custom',
            // What to do, said wherever an older manifest is refused (installed list, install, app_install / app_check): an
            // agent rewrites it as app_create writes Apps today — no table of what changed since 1 or 2 (owner 10-06).
            message: `apiVersion ${value} is an older App interface; ask an agent to rewrite the App for apiVersion ${EXTENSION_API_VERSION} as app_create writes Apps.`,
          });
        }
      }),
    /**
     * The oldest gugu this bundle runs on — `{ "gugu": ">=0.2.40" }` or `"^0.2.40"`.
     * Optional for hand-installed folders; the market requires it at publish time,
     * because there it is what picks the newest version a given machine can run.
     * Bump it whenever the bundle starts using a host verb that arrived in a
     * newer gugu; the API reference marks each verb with the version it arrived in.
     */
    engines: z
      .strictObject({
        gugu: z.string().regex(ENGINES_RANGE_PATTERN, {
          message: 'must be ">=x.y.z" or "^x.y.z" (a lower bound on the gugu version)',
        }),
      })
      .optional(),
    /**
     * Bundle-relative raster icon for the extension itself (the card, the detail
     * sheet, the installed list, and each tab that has no icon of its own). Same rules and the same decode/re-encode path as
     * a tab's `icon`; ❌ SVG.
     */
    icon: bundlePathSchema.optional(),
    /** Where to read more / where the source lives. https only; drawn as links. */
    homepage: httpsUrlSchema.optional(),
    repository: httpsUrlSchema.optional(),
    /** SPDX identifier or a short licence name, as text. Not verified. */
    license: z.string().trim().min(1).max(64).optional(),
    /**
     * Per-locale name and description, keyed by BCP 47 tag (`en`, `zh-CN`). The
     * base `name` / `description` stay required and single-string, so a bundle
     * that never heard of this field is unchanged; a reader in a listed locale
     * gets that text, everyone else gets the base.
     */
    localized: z
      .record(
        z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, { message: 'must be a BCP 47 tag' }),
        z.strictObject({
          name: z.string().trim().min(1).max(64).optional(),
          description: z.string().trim().min(1).max(280).optional(),
          subtitle: z.string().trim().min(1).max(30).optional(),
          examples: z.array(z.string().trim().min(1).max(80)).min(1).max(3).optional(),
        })
      )
      .optional(),
    /** Bundle-relative HTML entry loaded into the sandboxed webview. */
    entry: bundlePathSchema.optional(),
    /** User-editable configuration rendered by the host, passed to programs as GUGU_APP_SETTINGS. */
    settings: z.array(z.discriminatedUnion('type', [
      z.strictObject({ key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/), title: z.string().trim().min(1).max(80),
        description: z.string().max(280).optional(), type: z.literal('string'), default: z.string().max(4096).optional() }),
      z.strictObject({ key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/), title: z.string().trim().min(1).max(80),
        description: z.string().max(280).optional(), type: z.literal('boolean'), default: z.boolean().optional() }),
      z.strictObject({ key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/), title: z.string().trim().min(1).max(80),
        description: z.string().max(280).optional(), type: z.literal('select'),
        options: z.array(z.strictObject({ value: z.string().min(1).max(128), title: z.string().trim().min(1).max(80) })).min(1).max(32),
        default: z.string().max(128).optional() }),
    ])).min(1).max(32).optional(),
    /**
     * 常驻后台页 —— 一个扩展**一个**实例,与它的启用状态同生死,跟有没有 tab 开着无关。
     *
     * 这是「跨会话共享的活实例」的载体(owner 2026-09-10:「对我是想要跨会话的活实例」)。
     * 每条会话页上那一格是它的**视图**:视图切走照旧释放,因为活状态在这里,不在视图里。
     * 番茄钟这类「没人看也得继续跑」的扩展没有它就做不成 —— 视图各自持有状态时,
     * 用户看到的是 N 个互不相干的副本。
     *
     * **可选,而且默认没有**:声明了才有后台,所以 [[tab-extensions]]「常驻是例外,不是默认」
     * 原样成立 —— 常驻是扩展显式申请的能力,不是所有扩展白拿的默认。
     * 申请它要在安装时明说(见 permissions:「会在后台一直运行」),因为用户点头的是
     * 「这个东西会一直开着」,不是「这个东西有个页面」。
     */
    background: z.strictObject({ entry: bundlePathSchema }).optional(),
    permissions: permissionsSchema.optional(),
    contributes: z.strictObject({
      tabs: z.array(tabContributionSchema).min(1).max(8).default([{ name: 'settings', title: 'Settings', hostPage: 'settings' }]),
      mcpServers: z.array(mcpServerContributionSchema).min(1).max(4).optional(),
      /**
       * Bundle-relative folder of Agent Skills (`<skill>/SKILL.md`), handed to every agent
       * session as-is — text the agent reads, nothing gugu runs.
       */
      skills: bundlePathSchema.optional(),
      /** Standing behavior delivered in the session platform prompt, independently of skill discovery. */
      agentInstructions: z.string().trim().min(1).max(8000).optional(),
      /**
       * The App's own choice of how its programs' tools reach agents (owner 10-06「本身一个 app 自己初始化的时候也给自己
       * 抉择啊」): listed in every new session's tool list instead of the catalog (D-10's default). Read once, at the
       * first install — after that it is the person's switch, which no upgrade turns.
       */
      toolsListed: z.literal(true).optional(),
    }),
  })
  .superRefine((manifest, ctx) => {
    const managed = manifest.contributes.tabs.some((tab) => tab.hostPage === 'settings');
    if ((managed || manifest.settings) && manifest.apiVersion < 5) {
      ctx.addIssue({ code: 'custom', path: ['apiVersion'], message: 'host pages and settings require apiVersion 5' });
    }
    if (!manifest.entry && !manifest.contributes.tabs.some((tab) => tab.entry) && !manifest.contributes.mcpServers && !manifest.contributes.skills) {
      ctx.addIssue({ code: 'custom', path: ['entry'], message: 'an App without HTML must give agents programs or skills' });
    }
    const settingKeys = new Set<string>();
    for (const [index, field] of (manifest.settings ?? []).entries()) {
      if (settingKeys.has(field.key)) ctx.addIssue({ code: 'custom', path: ['settings', index, 'key'], message: 'duplicate setting key' });
      settingKeys.add(field.key);
      if (field.type === 'select') {
        if (new Set(field.options.map((option) => option.value)).size !== field.options.length) {
          ctx.addIssue({ code: 'custom', path: ['settings', index, 'options'], message: 'duplicate option value' });
        }
        if (field.default !== undefined && !field.options.some((option) => option.value === field.default)) {
          ctx.addIssue({ code: 'custom', path: ['settings', index, 'default'], message: 'default must name an option' });
        }
      }
    }
    for (const [index, tab] of manifest.contributes.tabs.entries()) {
      if (tab.hostPage) {
        if (tab.entry || tab.opensFiles || tab.menu?.length || tab.toolbar?.length) ctx.addIssue({ code: 'custom', path: ['contributes', 'tabs', index], message: 'a host settings page cannot have entry, opensFiles or page commands' });
      } else if (!tab.entry && !manifest.entry) {
        ctx.addIssue({ code: 'custom', path: ['contributes', 'tabs', index, 'entry'], message: 'an HTML tab needs its entry or the App entry' });
      }
      // A file's tab is already one page per file, and the settings page is one per App: neither has a task of its own.
      if (tab.perSession && (tab.hostPage || tab.opensFiles)) {
        ctx.addIssue({ code: 'custom', path: ['contributes', 'tabs', index, 'perSession'], message: 'a page per task cannot be a host page or open files' });
      }
      const claims = [...claimedSuffixes(tab, 'session'), ...claimedSuffixes(tab, 'chat')];
      for (const claim of Object.keys(tab.fileIcons ?? {})) {
        if (!claims.includes(claim)) {
          ctx.addIssue({ code: 'custom', path: ['contributes', 'tabs', index, 'fileIcons', claim], message: `"${claim}" is not one of this tab's opensFiles claims (${claims.join(', ') || 'none'}): fileIcons are keyed by them` });
        }
      }
    }
    // 同时声明窄的和宽的是自相矛盾的:安装清单要照哪一条写给用户看?默默取宽的
    // 那个,等于让「默认最小」在一个笔误上悄悄失效。当场判错。
    const declared = manifest.permissions?.capabilities ?? [];
    const byFamily = new Map<string, string>();
    for (const word of declared) {
      const { family } = capabilityReach(word);
      const other = byFamily.get(family);
      if (other !== undefined && other !== word) {
        ctx.addIssue({
          code: 'custom',
          path: ['permissions', 'capabilities'],
          message: `"${other}" 与 "${word}" 是同一个能力的两档 —— 只声明一档`,
        });
      }
      byFamily.set(family, word);
    }
    const categories = manifest.categories ?? [];
    if (new Set(categories).size !== categories.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'duplicate category',
      });
    }
    const servers = manifest.contributes.mcpServers ?? [];
    if (servers.some((server) => 'host' in server) && manifest.apiVersion < 5) {
      ctx.addIssue({ code: 'custom', path: ['apiVersion'], message: 'host MCP programs require apiVersion 5' });
    }
    if ((declared as readonly string[]).includes('chat:read') && manifest.apiVersion < 6) {
      ctx.addIssue({ code: 'custom', path: ['apiVersion'], message: 'chat:read requires apiVersion 6' });
    }
    const subtitled = manifest.subtitle !== undefined || Object.values(manifest.localized ?? {}).some((text) => text.subtitle !== undefined);
    if (subtitled && manifest.apiVersion < 8) {
      ctx.addIssue({ code: 'custom', path: ['apiVersion'], message: 'subtitle requires apiVersion 8' });
    }
    if (manifest.contributes.agentInstructions && servers.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['contributes', 'agentInstructions'], message: 'standing instructions require an MCP program' });
    }
    const extendsAgents = servers.length > 0 || manifest.contributes.skills !== undefined || manifest.contributes.agentInstructions !== undefined;
    const offersTools = (declared as readonly string[]).includes('agents:tools');
    if (extendsAgents && !offersTools) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'capabilities'],
        message: 'an App that gives agents MCP servers, skills or standing instructions must declare "agents:tools", so the install sheet says so',
      });
    }
    if (offersTools && !extendsAgents) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'capabilities'],
        // app_create takes these same fields, in its manifest (S1), so one name serves both.
        message: '"agents:tools" is declared but there are no contributes.mcpServers, contributes.skills or contributes.agentInstructions',
      });
    }
    if (manifest.contributes.toolsListed && servers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'toolsListed'],
        message: 'toolsListed lists the tools of the App\'s programs, and there are no contributes.mcpServers',
      });
    }
    const serverNames = new Set<string>();
    for (const [index, server] of servers.entries()) {
      const name = programName(server, manifest.id);
      if (serverNames.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'mcpServers', index],
          message: 'tools' in server ? 'one tools module per App' : `duplicate MCP server name "${name}"`,
        });
      }
      serverNames.add(name);
    }
    const seen = new Set<string>();
    for (const [index, tab] of manifest.contributes.tabs.entries()) {
      if (seen.has(tab.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'tabs', index, 'name'],
          message: `duplicate tab name "${tab.name}"`,
        });
      }
      seen.add(tab.name);
    }
  });

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export type ExtensionTabContribution = ExtensionManifest['contributes']['tabs'][number];
export type ExtensionMcpServerContribution = NonNullable<ExtensionManifest['contributes']['mcpServers']>[number];

/** A program's name among its App's (F119: a tools module is the App's own, so it is named after the App). */
export function programName(server: { name: string } | { tools: string }, appId: string): string {
  return 'tools' in server ? appId : server.name;
}

/** A host program as the install sheet names it: gugu's own capability, not a command. */
export function hostProgramLine(host: 'browser-use' | 'computer-use'): string {
  return host === 'browser-use' ? 'Gugu Browser Use' : 'Gugu Computer Use';
}

/** What a program runs, as the install sheet and the agent both read it: its command line, or (F77) its tools module. */
export function programLine(server: ExtensionMcpServerContribution): string {
  return 'host' in server ? hostProgramLine(server.host) : 'tools' in server ? server.tools : [server.command, ...(server.args ?? [])].join(' ');
}

export class ExtensionManifestError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid App manifest:\n- ${issues.join('\n- ')}`);
    this.name = 'ExtensionManifestError';
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

export function safeParseExtensionManifest(
  raw: unknown
): { ok: true; manifest: ExtensionManifest } | { ok: false; issues: string[] } {
  const result = extensionManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, manifest: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

/** Parse or throw an ExtensionManifestError carrying every violation. */
export function parseExtensionManifest(raw: unknown): ExtensionManifest {
  const result = safeParseExtensionManifest(raw);
  if (!result.ok) throw new ExtensionManifestError(result.issues);
  return result.manifest;
}

export function isValidExtensionId(value: string): boolean {
  return EXTENSION_ID_PATTERN.test(value);
}

/** Tab kind under which an extension tab registers: `<extensionId>.<tabName>`. */
/**
 * A tab kind contributed by an extension. The dot is what tells it apart from a
 * built-in kind at the type level as well as at runtime, so surfaces that keep their
 * own tab list can admit extension kinds without widening themselves to plain string.
 */
export type ExtensionTabKind = `${string}.${string}`;

export function extensionTabKind(extensionId: string, tabName: string): ExtensionTabKind {
  return `${extensionId}.${tabName}`;
}

export function parseExtensionTabKind(
  kind: string
): { extensionId: string; tabName: string } | null {
  const separator = kind.indexOf('.');
  if (separator === -1) return null;
  const extensionId = kind.slice(0, separator);
  const tabName = kind.slice(separator + 1);
  if (!EXTENSION_ID_PATTERN.test(extensionId)) return null;
  if (!TAB_NAME_PATTERN.test(tabName)) return null;
  return { extensionId, tabName };
}

/**
 * Hosts a new version asks for that the extension cannot already reach.
 *
 * Measured against what is *granted* — the declared list minus anything the
 * user took back — not against the installed manifest. A host that was revoked
 * must come back to be asked when a new version declares it again, or the
 * upgrade would quietly undo a decision the user made.
 *
 * "New" is decided by the same rule the network layer enforces, not by string
 * difference: an extension that declared `*.example.com` and now names
 * `api.example.com` has gained nothing, and re-asking about it would train the
 * user to click through. Widening the other way — `example.com` becoming
 * `*.example.com` — is a genuinely larger grant and does come back to be asked.
 *
 * Empty means an upgrade may land without another permission prompt: the user
 * already agreed to everything it can do. Refs #2374.
 */
export function newlyReachableHosts(
  granted: readonly string[],
  candidate: ExtensionManifest
): string[] {
  const requested = candidate.permissions?.network ?? [];
  return requested.filter(
    (host) => !granted.includes(host) && !networkHostAllowed(granted, host)
  );
}

/**
 * Orders two manifest versions ("x.y.z", numeric parts only — the schema admits
 * nothing else).
 *
 * Installing an older bundle over a newer one is not refused: the user picked
 * that folder, and inventing a rule the product contract does not state would be
 * deciding policy on the owner's behalf. What it must not do is happen quietly —
 * the confirm dialog says which way it is going, so "replacing" and "going back"
 * are not the same sentence. Refs #2374.
 */
export function compareExtensionVersions(left: string, right: string): number {
  const parse = (version: string) => version.split('.').map((part) => Number(part));
  const [leftParts, rightParts] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Where a file lives, for 「打开方式」: a session's working copy, or a chat's workspace (a group's, topic's, private chat's). */
export type FileOpenContext = 'session' | 'chat';

/**
 * Where a tab has something to do (摩擦单 F6 / F13 / L6-8): the contexts it declared in `opensFiles`.
 * Empty for a tab that opens no files. The one answer for the consent's wording, the session page's
 * tab bar and the bridge table.
 */
export function declaredContexts(tab: Parameters<typeof claimedSuffixes>[0]): FileOpenContext[] {
  return (['session', 'chat'] as const).filter((context) => claimedSuffixes(tab, context).length > 0);
}

/** Whether the App has something to open in a chat: a page of its own (it opens in any chat), or a tab of chat files. */
export function opensInChats(manifest: ExtensionManifest): boolean {
  return manifest.contributes.tabs.some((tab) => {
    const contexts = declaredContexts(tab);
    return contexts.length === 0 || contexts.includes('chat');
  });
}

/**
 * What `tab` claims in `context`: suffixes (`.csv`) and, since 摩擦单 F82, file names (`todo.md`, `todo-*.md`),
 * lowercased — matched and ranked by `fileOpenersFor` (file-openers.ts).
 */
export function claimedSuffixes(
  tab: { opensFiles?: { session?: readonly string[]; chat?: readonly string[] } },
  context: FileOpenContext
): readonly string[] {
  return tab.opensFiles?.[context] ?? [];
}
