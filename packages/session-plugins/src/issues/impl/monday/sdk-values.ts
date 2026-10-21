import type { ColumnType, ItemsOrderByDirection, ItemsQueryRuleOperator } from '@mondaydotcomorg/api';

// @@@monday-sdk-values — 本目录用到的几个 monday SDK 枚举值在这里按值写出,类型仍取自 SDK。
// ❌ 从 '@mondaydotcomorg/api' 值导入枚举:这一行会把整个 SDK 静态拉进主进程启动路径,抵掉
// integrations/impl/monday/client.ts 里的按需加载(mac1 2026-09-25 实测:这样写时 monday 的懒 chunk
// 在启动后就已在 require 缓存里)。值与 SDK 一致由 sdk-values.test.ts 对照真实枚举判定。
export const COLUMN_TYPE_DOC = 'doc' as ColumnType;
export const COLUMN_TYPE_LONG_TEXT = 'long_text' as ColumnType;
export const COLUMN_TYPE_TEXT = 'text' as ColumnType;
export const ITEMS_ORDER_BY_DESC = 'desc' as ItemsOrderByDirection;
export const ITEMS_RULE_CONTAINS_TEXT = 'contains_text' as ItemsQueryRuleOperator;
