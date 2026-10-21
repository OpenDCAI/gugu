// @@@monday-sdk-values — 写死的枚举值必须与所装 SDK 的真实枚举逐一相等;SDK 升级改了值,这里先红。
import { ColumnType, ItemsOrderByDirection, ItemsQueryRuleOperator } from '@mondaydotcomorg/api';
import { describe, expect, it } from 'vitest';
import {
  COLUMN_TYPE_DOC,
  COLUMN_TYPE_LONG_TEXT,
  COLUMN_TYPE_TEXT,
  ITEMS_ORDER_BY_DESC,
  ITEMS_RULE_CONTAINS_TEXT,
} from './sdk-values';

describe('monday SDK values', () => {
  it('match the SDK enums', () => {
    expect(COLUMN_TYPE_DOC).toBe(ColumnType.Doc);
    expect(COLUMN_TYPE_LONG_TEXT).toBe(ColumnType.LongText);
    expect(COLUMN_TYPE_TEXT).toBe(ColumnType.Text);
    expect(ITEMS_ORDER_BY_DESC).toBe(ItemsOrderByDirection.Desc);
    expect(ITEMS_RULE_CONTAINS_TEXT).toBe(ItemsQueryRuleOperator.ContainsText);
  });
});
