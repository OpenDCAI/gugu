import { z } from 'zod';

export const mcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * ⚠️ 合并视图里这一格的语义是**收窄过**的:`false` 只在**每一家都停用**时出现。
   * 「只在某几家停用」不写进这里,写进 `disabledIn` —— 见 `mergeMcpServersByName` 的抬头。
   * (写入方向不受影响:保存一台 server 时这里就是"要写给各家的那个值"。)
   */
  enabled: z.boolean().optional(),
  /**
   * 这台 server 被**显式停用**的那几家(`providers` 的子集;不写 = 一家都没停用)。
   *
   * 存在的理由:`providers` 是多家的**并集**,而启用状态是**逐家**的。
   * 少了这一格,「A 家开着、B 家关着」只能被压成一个扁平布尔值,
   * 而那个值无论取 true 还是 false 都在说一句假话(铁律 7:读数为真、归属为假)。
   */
  disabledIn: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
  oauth: z.union([z.record(z.string(), z.unknown()), z.literal(false)]).optional(),
  providers: z.array(z.string()),
});

export type McpServer = z.infer<typeof mcpServerSchema>;
