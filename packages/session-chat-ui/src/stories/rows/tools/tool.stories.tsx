/** @jsxImportSource solid-js */
/**
 * Tool row stories — generic tool call in each status.
 */

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { ChatHost, ChatHostExpanded, ScriptedChat } from '@session-chat/stories/_harness/chat-host';
import { ToolStateMatrix } from '@session-chat/stories/_harness/state-matrix';
import { scenario, seedStep, streamTool } from '@session-chat/stories/_harness/streaming/scenario';

const meta: Meta = {
  title: 'Rows/Tools/Tool',
  component: ChatHost,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ChatHost>;

export const StateMatrix: Story = {
  render: () => (
    <ToolStateMatrix
      build={(status) => ({
        kind: 'tool',
        id: `t-matrix-${status}`,
        name: 'search',
        status,
        inputSummary: 'SolidJS virtualized list patterns',
      })}
    />
  ),
};

export const Running: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'tool',
          id: 't1',
          name: 'search',
          status: 'running',
          inputSummary: 'SolidJS virtualized list patterns',
        },
      ]}
      height={80}
    />
  ),
};

/** Streaming simulation: tool starts running then transitions to done. */
export const RunningStreamed: Story = {
  render: () => (
    <ScriptedChat
      height={120}
      script={scenario(
        [seedStep([{ kind: 'message', id: 'u1', role: 'user', text: 'Search for patterns' }])],
        streamTool({
          id: 't-stream',
          name: 'search',
          inputSummary: 'SolidJS virtualized list patterns',
          steps: [{ afterMs: 1200, status: 'done' }],
        })
      )}
    />
  ),
};

export const Done: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'tool',
          id: 't2',
          name: 'fetch_url',
          status: 'done',
          inputSummary: 'https://solidjs.com/docs/latest',
        },
      ]}
      height={80}
    />
  ),
};

export const Error: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'tool',
          id: 't3',
          name: 'web.run',
          status: 'error',
          error: 'Search provider returned a 503 response',
          inputSummary: 'latest ACP protocol specification',
        },
      ]}
      height={110}
    />
  ),
};

/**
 * The product shape of a failure: nothing on the ACP path sets `error`, so the
 * reason arrives in `result` and the row re-slots it. Collapsed, and the reason
 * is already legible — no hover, which is the only way it works on a phone.
 */
export const FailureReason: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'tool',
          id: 't-failure',
          name: 'Fetch',
          status: 'error',
          inputSummary: 'https://example.invalid/reference',
          result: 'getaddrinfo ENOTFOUND example.invalid',
        },
      ]}
      height={110}
    />
  ),
};

/** A stack trace: capped at the failure section's own tighter cap, and scrollable. */
export const FailureTrace: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'tool',
          id: 't-failure-trace',
          name: 'mcp__db__migrate',
          status: 'error',
          inputSummary: 'db.migrate',
          result: [
            'QueryFailedError: relation "chat.messages" does not exist',
            ...Array.from(
              { length: 20 },
              (_, index) => `    at frame-${index} (/src/db/query.ts:${index + 11}:${index + 3})`
            ),
          ].join('\n'),
        },
      ]}
      height={220}
    />
  ),
};

const SEARCH_REQUEST =
  '{"pattern":"measure contract","path":"packages/session-chat-ui/src","glob":"**/*.{ts,tsx}","caseSensitive":false,"maxResults":50}';
const SEARCH_RESULT =
  '4 matches in 3 files\npackages/task-chat-ui/src/core/define.ts:12\npackages/task-chat-ui/src/tests/height.contract.test.tsx:37\nREADME.md:88';

/** Collapsed: the payload row is indistinguishable from a plain one but for the chevron. */
export const WithPayloadCollapsed: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'tool',
          id: 't-payload',
          name: 'Search',
          status: 'done',
          inputSummary: 'measure contract (4 matches)',
          request: SEARCH_REQUEST,
          result: SEARCH_RESULT,
        },
      ]}
      height={80}
    />
  ),
};

/** Expanded: the arguments and the result the row was opened for. */
export const WithPayloadExpanded: Story = {
  render: () => (
    <ChatHostExpanded
      expandId="t-payload"
      items={[
        {
          kind: 'tool',
          id: 't-payload',
          name: 'Search',
          status: 'done',
          inputSummary: 'measure contract (4 matches)',
          request: SEARCH_REQUEST,
          result: SEARCH_RESULT,
        },
      ]}
      height={220}
    />
  ),
};

/** A failed call still opens: the arguments are what a reader needs to see why. */
export const FailedWithPayloadExpanded: Story = {
  render: () => (
    <ChatHostExpanded
      expandId="t-payload-error"
      items={[
        {
          kind: 'tool',
          id: 't-payload-error',
          name: 'Fetch',
          status: 'error',
          error: 'unreachable host',
          inputSummary: 'https://example.invalid/reference',
          request: '{"url":"https://example.invalid/reference","timeoutMs":10000}',
          result: 'getaddrinfo ENOTFOUND example.invalid',
        },
      ]}
      height={200}
    />
  ),
};

/** Permission request beneath a running generic tool call. */
export const RequestingPermission: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'tool',
          id: 't-perm',
          name: 'search',
          status: 'running',
          inputSummary: 'SolidJS virtualized list patterns',
        },
      ]}
      height={120}
    />
  ),
};
