import { basename } from 'node:path';
import type { McpServer } from '@gugu/session-core/mcp';
import { KV } from '@main/db/kv';
import { guguMcpStdioRelayEntryPath } from '@main/worker-manifest';
import type { SessionLibraryMcpFact } from '@shared/core/sessions/session-config';
import {
  libraryMcpConflict,
  libraryMcpServerSchema,
  libraryMcpServersSchema,
  type LibraryMcpCheck,
  type LibraryMcpHarnessServer,
  type LibraryMcpServer,
} from '@shared/mcp-library';
import { GUGU_MCP_SERVER_NAME } from '../../../../mcp/gugu-mcp-name.mjs';
import { mcpService } from '../mcp/services/McpService';
import { checkLibraryMcp } from './check';

const libraryKV = new KV<{ servers: LibraryMcpServer[] }>('mcp-library');

/**
 * 咕咕写进某家配置根的条目(独立 home 的家:`gugu` 那台,以及经 stdio 中继接进去的每一台)—— 不是用户配的,
 * 不列在「各家自己的」那一组里。认中继按**文件名**,❌ 按全路径:应用升级后路径会变,而旧条目要到下一次开会话才改写。
 */
/** 各家读回来的一台 → 资源库那一行的形状(去掉空的格子)。 */
function libraryShapeOf(server: McpServer): LibraryMcpHarnessServer['server'] {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
  };
}

function isGuguOwnedServer(server: McpServer): boolean {
  if (server.name === GUGU_MCP_SERVER_NAME) return true;
  const relay = basename(guguMcpStdioRelayEntryPath());
  return (server.args ?? []).some((arg) => basename(arg) === relay);
}

/** 这台机器的 MCP 列表。存在 KV('mcp-library'),和提示词库同一种做法;别的机器经设备 RPC 问它自己的这一份。 */
export class McpLibraryService {
  /** 存着的读不懂 ⇒ 抛(❌ 当成空表:那会让下一次保存把用户的列表整个盖掉)。 */
  async list(): Promise<LibraryMcpServer[]> {
    return libraryMcpServersSchema.parse((await libraryKV.get('servers')) ?? []);
  }

  /** 写之前整份过一遍撞名(保留名、名字只差标点、同一个 URL):撞了的那一台送进会话时会被留在外面,❌ 先存进来。 */
  private async write(servers: LibraryMcpServer[]): Promise<void> {
    const parsed = libraryMcpServersSchema.parse(servers);
    for (const [index, server] of parsed.entries()) {
      const conflict = libraryMcpConflict(server, parsed.slice(0, index));
      if (conflict) throw new Error(`MCP '${server.name}' ${conflict.code}${'with' in conflict ? ` with '${conflict.with}'` : ''}`);
    }
    await libraryKV.setOrThrow('servers', parsed);
  }

  /** 加几台(粘进来的 JSON 可以一次几台);同名的一台都不加,整批报出来。 */
  async add(servers: LibraryMcpServer[]): Promise<void> {
    const current = await this.list();
    const taken = new Set(current.map((server) => server.name));
    const clash = servers.filter((server) => taken.has(server.name)).map((server) => server.name);
    if (clash.length > 0) throw new Error(`MCP already in the library: ${clash.join(', ')}`);
    await this.write([...current, ...servers.map((server) => libraryMcpServerSchema.parse(server))]);
  }

  /** 改一台;名字不能改(任务按名字记选了哪几台)。配置改了,上次的检测结果就不算数了。 */
  async update(server: LibraryMcpServer): Promise<void> {
    const current = await this.list();
    const index = current.findIndex((item) => item.name === server.name);
    if (index === -1) throw new Error(`MCP not in the library: ${server.name}`);
    const { check: _stale, ...rest } = libraryMcpServerSchema.parse(server);
    await this.write(current.map((item, at) => (at === index ? rest : item)));
  }

  async remove(name: string): Promise<void> {
    const current = await this.list();
    if (!current.some((item) => item.name === name)) throw new Error(`MCP not in the library: ${name}`);
    await this.write(current.filter((item) => item.name !== name));
  }

  async setEnabledByDefault(name: string, enabledByDefault: boolean): Promise<void> {
    const current = await this.list();
    if (!current.some((item) => item.name === name)) throw new Error(`MCP not in the library: ${name}`);
    await this.write(current.map((item) => (item.name === name ? { ...item, enabledByDefault } : item)));
  }

  /** 手动检测一台,结果记回那条记录。 */
  async check(name: string): Promise<LibraryMcpCheck> {
    const server = (await this.list()).find((item) => item.name === name);
    if (!server) throw new Error(`MCP not in the library: ${name}`);
    const result = await checkLibraryMcp(server);
    // 检测跑着的时候那一台可能被改过或删了:只在它还是这一份时记回去。
    const latest = await this.list();
    const same = latest.find((item) => item.name === name);
    if (same && JSON.stringify({ ...same, check: undefined }) === JSON.stringify({ ...server, check: undefined })) {
      await this.write(latest.map((item) => (item.name === name ? { ...item, check: result } : item)));
    }
    return result;
  }

  /**
   * 各家**自己的**用户级配置里的那几台(各家 adapter 的读法,只读文件、不跑 CLI),咕咕自己写进去的不算。
   * 资源库里与咕咕的那几台并排列出;❌ 改各家的文件。
   */
  async harnessServers(providerIds: readonly string[]): Promise<LibraryMcpHarnessServer[]> {
    const rows: LibraryMcpHarnessServer[] = [];
    for (const providerId of providerIds) {
      for (const server of await mcpService.listForAgent(providerId)) {
        if (isGuguOwnedServer(server)) continue;
        rows.push({ providerId, server: libraryShapeOf(server) });
      }
    }
    return rows;
  }

  /** 检测那一家自己的一台:咕咕照那份配置起一次,不记下来(那不是咕咕的记录)。 */
  async checkHarnessServer(providerId: string, name: string): Promise<LibraryMcpCheck> {
    const server = (await this.harnessServers([providerId])).find((row) => row.server.name === name);
    if (!server) throw new Error(`MCP ${name} is not in ${providerId}'s own config`);
    return checkLibraryMcp({ ...server.server, enabledByDefault: false });
  }

  /** 一条任务选中的那几台,按名字现取;列表里已经没有的名字原样报回来(任务的 `/mcp` 面板写明)。 */
  async selected(names: readonly string[]): Promise<{ servers: LibraryMcpServer[]; missing: string[] }> {
    const byName = new Map((await this.list()).map((server) => [server.name, server]));
    return {
      servers: names.flatMap((name) => byName.get(name) ?? []),
      missing: names.filter((name) => !byName.has(name)),
    };
  }
}

/**
 * 一条任务带的那几台里,哪几台送、哪几台留在外面和为什么 —— 按顺序判:资源库里已经没有 / 这一家这条腿收不到 /
 * 这条腿不收这种传输 / 这一家这条任务自己就有同名的(以它自己的为准)。和咕咕自己送的那几台撞名,在建能力包时再判一次。
 */
export function planLibraryMcpDelivery(input: {
  servers: readonly LibraryMcpServer[];
  missing: readonly string[];
  delivery: { channel: false } | { channel: true; transports: readonly ('stdio' | 'http')[] };
  own: ReadonlySet<string>;
}): { servers: LibraryMcpServer[]; leftOut: SessionLibraryMcpFact['leftOut'] } {
  const leftOut: SessionLibraryMcpFact['leftOut'] = input.missing.map((name) => ({ name, reason: 'missing' }));
  const { delivery } = input;
  if (!delivery.channel) {
    return { servers: [], leftOut: [...leftOut, ...input.servers.map((server) => ({ name: server.name, reason: 'no-channel' as const }))] };
  }
  const servers: LibraryMcpServer[] = [];
  for (const server of input.servers) {
    if (!delivery.transports.includes(server.transport)) leftOut.push({ name: server.name, reason: 'no-stdio' });
    else if (input.own.has(server.name)) leftOut.push({ name: server.name, reason: 'shadowed' });
    else servers.push(server);
  }
  return { servers, leftOut };
}

export const mcpLibraryService = new McpLibraryService();
