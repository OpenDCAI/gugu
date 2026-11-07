// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { TabLayerShownContext } from '@renderer/features/tabs/retained-tab-content';
import { SessionChatLoading } from './session-chat-loading';

vi.mock('@/components/chat/MessageListSkeleton', () => ({ MessageListSkeleton: () => <i data-skeleton /> }));

const drawn = (shown: boolean) => renderToStaticMarkup(
  <TabLayerShownContext.Provider value={shown}><SessionChatLoading label="Loading" /></TabLayerShownContext.Provider>,
);

it('draws its skeleton only in a layer on screen: animations do not stop under content-visibility:hidden', () => {
  expect(drawn(true)).toContain('data-skeleton');
  expect(drawn(false)).toBe('');
});
