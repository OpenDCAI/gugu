import { err, ok } from '@gugu/session-shared';
import type { McpOAuthCredentials } from '../../../integrations/helpers/mcp-oauth';
import {
  callMcpToolJson,
  McpToolError,
  withMcpClient,
} from '../../../integrations/helpers/mcp-tool-client';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import { readLinearCredentials } from '../../../integrations/impl/linear/client';
import { toLinearIntegrationError } from '../../../integrations/impl/linear/error';
import {
  type LinearIssueNode,
  linearIssueSchema,
  readIssueNodes,
} from '../../../integrations/impl/linear/types';
import { clampIssueLimit, normalizeSearchTerm } from '../../helpers/provider-inputs';
import { defineIssuesPlugin, registerIssuesPluginBehavior } from '../../plugin';
import type {
  IssueData,
  IssueGetOpts,
  IssueGetResult,
  IssueListResult,
  IssueSearchOpts,
} from '../../types';

/**
 * 工单从 Linear 的托管 MCP 读,不再打 GraphQL —— 浏览器授权拿到的令牌是发给 MCP 服务器的,
 * 打不了 Linear 的公开 API。
 *
 * ⚠️ UNVERIFIED(2026-09-15):`list_issues` / `get_issue` 的**返回体形状**没有公开文档,
 * 而 tools/list 要先授权才看得到,所以这里的解析是宽松的:外层裸数组 / `issues` / `nodes` /
 * `results` 四种都收,字段除标题外全部可缺。真连上一个 Linear 工作区跑通之前,❌ 别把它当已验证。
 */
async function callIssueTool(
  credentials: McpOAuthCredentials,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return withMcpClient(credentials, (client) => callMcpToolJson(client, tool, args));
}

function toIssueData(node: LinearIssueNode): IssueData {
  const assignee = node.assignee?.displayName || node.assignee?.name;
  return {
    identifier: node.identifier ?? node.id ?? node.title,
    title: node.title,
    ...(node.url ? { url: node.url } : {}),
    ...(node.description ? { description: node.description } : {}),
    ...(node.branchName ? { branchName: node.branchName } : {}),
    ...(node.state?.name ? { status: node.state.name } : {}),
    ...(assignee ? { assignees: [assignee] } : {}),
    ...(node.project?.name ? { project: node.project.name } : {}),
    ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}),
  };
}

function parseIssueList(tool: string, raw: unknown): LinearIssueNode[] {
  const nodes = readIssueNodes(raw);
  if (!nodes) throw new McpToolError(tool, `${tool} returned an unexpected response.`);
  return nodes;
}

export async function searchIssues(
  host: ConnectedIntegrationHostContext,
  opts: IssueSearchOpts
): Promise<IssueListResult> {
  const term = normalizeSearchTerm(opts.searchTerm);
  if (!term) return ok([]);
  const credentials = readLinearCredentials(host.credentials);
  if (!credentials.success) return err(credentials.error);
  const limit = clampIssueLimit(opts.limit, 20, 200);
  try {
    // 官方 MCP 没有单独的 search 工具,查询是 list_issues 的一个参数。
    const raw = await callIssueTool(credentials.data, 'list_issues', { query: term, limit });
    return ok(parseIssueList('list_issues', raw).map(toIssueData));
  } catch (error) {
    host.log.warn('Linear searchIssues failed', { error });
    return err(toLinearIntegrationError(error, 'Unable to search Linear issues.'));
  }
}

export async function getIssue(
  host: ConnectedIntegrationHostContext,
  opts: IssueGetOpts
): Promise<IssueGetResult> {
  const identifier = normalizeSearchTerm(opts.identifier);
  if (!identifier) {
    return err({ type: 'invalid_input', message: 'Linear issue identifier is required.' });
  }
  const credentials = readLinearCredentials(host.credentials);
  if (!credentials.success) return err(credentials.error);
  try {
    const raw = await callIssueTool(credentials.data, 'get_issue', { id: identifier });
    const parsed = linearIssueSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpToolError('get_issue', 'get_issue returned an unexpected response.');
    }
    return ok(toIssueData(parsed.data));
  } catch (error) {
    host.log.warn('Linear getIssue failed', { error });
    return err(toLinearIntegrationError(error, 'Unable to fetch Linear issue context.'));
  }
}

const plugin = defineIssuesPlugin({ integrationId: 'linear' }, { issues: {} }, {});

export const provider = registerIssuesPluginBehavior(plugin, {
  issues: { searchIssues, getIssue },
});
