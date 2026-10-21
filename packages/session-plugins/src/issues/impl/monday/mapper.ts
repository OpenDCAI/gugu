import type { IssueData, IssueDetail } from '../../types';
import type { MondayBoard, MondayColumnValue, MondayItem } from './queries';
import { COLUMN_TYPE_LONG_TEXT, COLUMN_TYPE_TEXT } from './sdk-values';

export function toIssueData(item: MondayItem, board: Pick<MondayBoard, 'url'>): IssueData {
  return {
    identifier: item.id,
    title: item.name,
    url: `${board.url}/pulses/${item.id}`,
    description: extractDescription(item.column_values),
    updatedAt: item.updated_at ?? undefined,
  };
}

export function toIssueDetail(
  item: MondayItem,
  board: Pick<MondayBoard, 'url'>,
  context: string | undefined,
  description: string | undefined
): IssueDetail {
  return {
    ...toIssueData(item, board),
    description,
    context,
  };
}

export function extractDescription(columnValues: MondayColumnValue[]): string | undefined {
  const longText = columnValues.find(
    (column) => column.type === COLUMN_TYPE_LONG_TEXT || column.type === COLUMN_TYPE_TEXT
  );
  return longText?.text || undefined;
}
