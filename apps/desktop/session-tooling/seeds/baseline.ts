import type { AppDb } from '@main/db/client';
import { sessions, projectRemotes, projects, projectSettings } from '@main/db/schema';

// Fixed UUIDs so fixture content is stable across regenerations.
const PROJECT_A_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_B_ID = '22222222-2222-2222-2222-222222222222';

const CONV_A1_ID = 'cccc0001-0000-0000-0000-000000000000';
const CONV_A2_ID = 'cccc0002-0000-0000-0000-000000000000';

/**
 * Realistic but fully synthetic dataset — no sensitive data.
 * Represents a developer's day-to-day session-page state: two projects,
 * and a couple of sessions in their workspaces.
 */
export async function baseline(db: AppDb): Promise<void> {
  await db.insert(projects).values([
    {
      id: PROJECT_A_ID,
      name: 'demo-app',
      path: '/home/dev/projects/demo-app',
      workspaceProvider: 'local',
      baseRef: 'main',
    },
    {
      id: PROJECT_B_ID,
      name: 'my-api',
      path: '/home/dev/projects/my-api',
      workspaceProvider: 'local',
      baseRef: 'main',
    },
  ]);

  await db.insert(projectRemotes).values([
    {
      projectId: PROJECT_A_ID,
      remoteName: 'origin',
      remoteUrl: 'https://github.com/example/demo-app.git',
    },
    {
      projectId: PROJECT_B_ID,
      remoteName: 'origin',
      remoteUrl: 'https://github.com/example/my-api.git',
    },
  ]);

  await db
    .insert(projectSettings)
    .values([{ projectId: PROJECT_A_ID }, { projectId: PROJECT_B_ID }]);

  await db.insert(sessions).values([
    {
      id: CONV_A1_ID,
      projectId: PROJECT_A_ID,
      title: 'Plan workspace schema',
      provider: 'anthropic',
      workspaceId: `local:${PROJECT_A_ID}:branch:feat/workspace-db`,
    },
    {
      id: CONV_A2_ID,
      projectId: PROJECT_A_ID,
      title: 'Design fixture tooling',
      provider: 'anthropic',
      workspaceId: `local:${PROJECT_A_ID}:branch:feat/migration-testing`,
    },
  ]);
}
