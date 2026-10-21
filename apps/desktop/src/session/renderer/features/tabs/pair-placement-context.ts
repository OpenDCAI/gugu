import { createContext, type CSSProperties } from 'react';

/**
 * 同一种两页并排、这种页签自己摆两页时(TabProvider.placesPairItself,spec session-page「并排」):
 * 这一枚页签此刻摆在这一格的哪一块;不在这一对里 = null。别的时候没有这个上下文(null),内容照常铺满。
 */
export const PairPlacementContext = createContext<((tabId: string) => CSSProperties | null) | null>(null);
