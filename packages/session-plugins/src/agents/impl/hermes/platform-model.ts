import type { IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';
import { hermesPlatformEnv } from './session-bundle';

// Hermes over `hermes serve`: Gugu's bridge writes the platform provider, the selected model and the whole
// switchable set (each model's window and reasoning levels) into serve's managed config (Gugu-owned, never the
// user's HERMES_HOME); `load` hands it these facts through the bridge's environment.
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_HERMES_MODEL'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.platformProvider && input.platformAccess?.reasoningEfforts
      ? { reasoningEfforts: input.platformAccess.reasoningEfforts }
      : {}),
  }),
  // The bridge's environment carries the relay, the token, the model and the switchable set; the bridge
  // writes them into serve's Gugu-owned managed config. Same keys as the session materializer (one helper).
  load: (model) => ({ spawnEnv: hermesPlatformEnv(model) }),
};
