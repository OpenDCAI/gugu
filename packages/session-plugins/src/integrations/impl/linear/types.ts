import z from 'zod';

/**
 * Linear 的托管 MCP。**只读那一条** —— 咕咕只读工单,不写;Linear 文档:
 * 「Connect to `https://mcp.linear.app/mcp/readonly`, which only ever exposes read tools.」
 * 授权页因此也只要读权限,用户不必把写权限交出来。
 */
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp/readonly';

export const LINEAR_RECONNECT_MESSAGE =
  'Linear now connects through browser authorization. Disconnect Linear and connect it again.';

/**
 * 工单在 MCP 工具返回里的形状。**字段一律宽松**:除了标题,其余都可缺 ——
 * 这是别人家服务器的返回,少一格不该让整张列表打不开。
 */
export const linearIssueSchema = z.looseObject({
  id: z.string().optional(),
  /** 人读的编号,例如 LIN-123。 */
  identifier: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  description: z.string().optional(),
  branchName: z.string().optional(),
  updatedAt: z.string().optional(),
  state: z.looseObject({ name: z.string().optional() }).optional(),
  project: z.looseObject({ name: z.string().optional() }).optional(),
  assignee: z
    .looseObject({ name: z.string().optional(), displayName: z.string().optional() })
    .optional(),
});

export type LinearIssueNode = z.infer<typeof linearIssueSchema>;

/**
 * `list_issues` / `get_issue` 返回的外层可能是裸数组,也可能包一层(issues / nodes / results)。
 * 四种都试;都不认就返回 null,交给调用点报错 —— ❌ 别默默返回空列表,那会被读成「没有工单」。
 */
const wrappedIssueListSchemas = [
  z.object({ issues: z.array(linearIssueSchema) }),
  z.object({ nodes: z.array(linearIssueSchema) }),
  z.object({ results: z.array(linearIssueSchema) }),
] as const;

export function readIssueNodes(raw: unknown): LinearIssueNode[] | null {
  const bare = z.array(linearIssueSchema).safeParse(raw);
  if (bare.success) return bare.data;
  for (const schema of wrappedIssueListSchemas) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return Object.values(parsed.data)[0] as LinearIssueNode[];
  }
  return null;
}
