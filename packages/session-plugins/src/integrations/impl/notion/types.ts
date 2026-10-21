import z from 'zod';

export const NOTION_MCP_URL = 'https://mcp.notion.com/mcp';

export const NOTION_RECONNECT_MESSAGE =
  'Notion now connects through browser authorization. Disconnect Notion and connect it again.';

// Notion MCP tools answer with a JSON document inside their text content. Only
// the fields the issue picker reads are required; the rest passes through.
export const notionSearchResultSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  type: z.string(),
  highlight: z.string().optional(),
  timestamp: z.string().optional(),
});

export const notionSearchResponseSchema = z.looseObject({
  results: z.array(notionSearchResultSchema),
});

export const notionFetchResponseSchema = z.looseObject({
  title: z.string(),
  url: z.string(),
  /** The page rendered as Notion-flavored markdown, properties included. */
  text: z.string(),
});

export type NotionSearchResult = z.infer<typeof notionSearchResultSchema>;
