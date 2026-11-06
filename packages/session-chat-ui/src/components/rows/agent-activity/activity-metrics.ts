/** Shared geometry for semantic-row paint and width allocation. */
export const ACTIVITY_METRICS = { height: 44, icon: 14, chevron: 12, gap: 6, paddingX: 5 } as const;
export const ACTIVITY_LABEL_INSET = ACTIVITY_METRICS.icon + ACTIVITY_METRICS.chevron
  + 2 * ACTIVITY_METRICS.gap + 2 * ACTIVITY_METRICS.paddingX;
