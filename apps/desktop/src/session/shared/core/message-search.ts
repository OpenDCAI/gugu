import type { SearchQuery } from '@gugu/core/shared/search/types';

export interface MessageSearchRequest {
  query: SearchQuery;
  limit?: number;
  cursor?: string | null;
}
