// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { publishChatSummaries } from '@/lib/chatSummariesBridge';
import { chatDisplayName } from './chat-name';

const projects = vi.hoisted(() => ({ name: 'another local folder' }));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({
  projectGroupsStore: { projectOfChat: () => 'local-project' },
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectStore: () => projects,
  projectDisplayName: (project: typeof projects) => project.name,
}));

beforeEach(() => publishChatSummaries([]));

it('names the actual destination group instead of an arbitrary local folder bound to that group', () => {
  publishChatSummaries([{ id: 'group-id', kind: 'group', name: 'Shared project', public_id: 1234, unread_count: 0 }]);
  expect(chatDisplayName('group-id')).toBe('Shared project');
  expect(chatDisplayName('1234')).toBe('Shared project');
});

it('preserves an explicit personal group alias', () => {
  publishChatSummaries([{ id: 'group-id', kind: 'group', name: 'Shared project', alias: 'My project', unread_count: 0 }]);
  expect(chatDisplayName('group-id')).toBe('My project');
});

it('can name a known project before the shell has loaded its group summary', () => {
  expect(chatDisplayName('group-id')).toBe(projects.name);
});
