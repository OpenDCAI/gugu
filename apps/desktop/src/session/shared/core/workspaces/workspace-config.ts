import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

// ---------------------------------------------------------------------------
// v1 schema — stored in workspaces.config rows created before v2
// ---------------------------------------------------------------------------

const v1Schema = z.object({
  version: z.literal('1'),
  workspace: z.object({ host: z.string() }),
});

// ---------------------------------------------------------------------------
// v2 schema — current version
// ---------------------------------------------------------------------------

const workspaceTargetSchema = z.object({
  kind: z.literal('repository-instance'),
  workspaceId: z.string(),
});

const v2Schema = z.object({
  version: z.literal('2'),
  workspace: workspaceTargetSchema,
});

// ---------------------------------------------------------------------------
// Versioned schema
// ---------------------------------------------------------------------------

/**
 * Versioned schema for workspace configuration stored in `workspaces.config`.
 *
 * A task runs in the project's own working tree. The product never provisions a
 * git worktree and never creates a task branch, so a config carries only where
 * the workspace lives — there is no git setup to describe.
 *
 * v1 → v2 upgrade: always `null` (needs-context). A v1 row names only a host, never the
 * `repositoryWorkspaceId` a `repository-instance` target needs, so it reads as no config.
 */
export const workspaceConfig = defineVersionedSchema()
  .initial('1', v1Schema)
  .version('2', v2Schema, () => null)
  .build();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** The Zod schema for the latest (v2) workspace config. */
export const workspaceConfigSchema = workspaceConfig.schema;

/** The TypeScript type for the latest (v2) workspace config. */
export type WorkspaceConfig = typeof workspaceConfig.Type;

/** The TypeScript type for the `workspace` field of a v2 config. */
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;
