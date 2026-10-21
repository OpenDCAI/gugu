import os from 'node:os';
import { AgentPluginHost, type CLIAgentPluginProvider } from '@gugu/session-core/agents/plugins';
import {
  createAgentHomeProvisioner,
  createLocalPluginFs,
  resolveAgentHome,
} from '@gugu/session-core/agents/plugins/helpers';
import {
  createLedgerBackedDetector,
  createReplicaLedger,
  toPlatform,
} from '@gugu/session-core/deps/runtime';
import { diskWindowsShimReader, NodeExecutionContext } from '@gugu/session-core/exec';
import { NodePtySpawner } from '@gugu/session-core/pty/node';
import { agentConfigRuntimeContract } from '@gugu/session-core/workspace-server';
import { initProcessLogging } from '@gugu/session-shared/logger/node';
import type { PluginRegistry } from '@gugu/session-shared/plugins';
import { withValidation } from '@gugu/session-wire';
import {
  serveWorkerProcess,
  workerValidatePolicy,
  type ProcessRuntimePort,
} from '@gugu/session-wire/util/process-runtime';
import { createAgentConfigController } from '../api/controller';
import { AgentConfigRuntime } from '../runtime/runtime';
import { AuthExpiryMarks } from '../runtime/auth-expiry';
import { homeKeyedAuthExpiryPersistence } from './auth-expiry-file';

export type BootAgentConfigRuntimeProcessOptions = {
  pluginRegistry: PluginRegistry<CLIAgentPluginProvider>;
  env?: NodeJS.ProcessEnv;
  port?: ProcessRuntimePort;
  exit?: (code: number) => void;
  resolveProviderEnv?: (providerId: string) => Promise<Record<string, string>> | Record<string, string>;
};

export function bootAgentConfigRuntimeProcess(options: BootAgentConfigRuntimeProcessOptions): void {
  const env = options.env ?? process.env;
  const logger = initProcessLogging({ name: 'agent-config-runtime', env });

  void serveWorkerProcess(
    (scope) => {
      const homeDir = os.homedir();
      const spawner = new NodePtySpawner();
      const runtimeScope = scope.child('agent-config-runtime');
      const exec = new NodeExecutionContext({ env });
      // 这台机器那本账的**副本** —— 由主进程 `syncHostDependencyLedger` 推进来(#6101)。
      // ❌ 这个进程不自己探「谁装的 / 用户选了哪一份」:它够不到主进程的 KV,自己探出来的
      // 是第二套读数。
      const hostDependencyLedger = createReplicaLedger();
      const agentHost = new AgentPluginHost({
        windowsShimReader: diskWindowsShimReader,
        scope: runtimeScope,
        registry: options.pluginRegistry,
        exec,
        fs: createLocalPluginFs(homeDir, { mcpWriteScope: 'user-config' }),
        homeDir,
        hostDependencies: {
          ledger: hostDependencyLedger,
          // 咕咕自己那些目录也在账上 —— 路径由属主算(它是唯一知道 GUGU_HOME 落在哪的那一侧),
          // 这边只按它说的认。
          installMethodDetector: createLedgerBackedDetector(
            exec,
            toPlatform(process.platform),
            hostDependencyLedger
          ),
          // 量一家 agent 的版本,用它真跑起来时那份环境(#5702)。同样是主进程算好递进来的。
          resolveProbeEnv: (descriptor) =>
            Promise.resolve(hostDependencyLedger.probeEnvFor(descriptor.id)),
        },
        // 独立 home:声明了 `configRoot` 的家读写咕咕自己那一份配置根。
        // 没有 GUGU_HOME 时返回 undefined = 整套不启用(❌ 不猜路径)。
        agentHome: createAgentHomeProvisioner(env.GUGU_HOME, homeDir, env),
        resolveProviderEnv: options.resolveProviderEnv,
      });
      const expiryFile = env.GUGU_AGENT_AUTH_EXPIRY_FILE?.trim();
      // 这家的登录态住在哪个配置家:托管的家 = 这个账号自己的影子 home;其余 = 这个 Linux 用户真正的 home
      // (同机几个咕咕账号共用)。纯路径拼接,❌ 不在这里复制/建影子 home。
      const harnessHomeKey = (providerId: string): string => {
        let home = homeDir;
        const bundle = options.pluginRegistry.get(providerId)?.capabilities.sessionBundle;
        const guguHome = env.GUGU_HOME?.trim();
        if (bundle && guguHome && bundle.injectionMode === 'managed-config-root') {
          try {
            home =
              resolveAgentHome({
                providerId,
                injectionMode: bundle.injectionMode,
                configRoot: bundle.configRoot,
                guguHome,
                osHomeDir: homeDir,
                sourceEnv: env,
              })?.shadowHome ?? homeDir;
          } catch {
            // 声明自相矛盾时 plugin host 自己会响亮报;这里按真 home 记,❌ 让标记整体失效
          }
        }
        return `${providerId}|${home}`;
      };
      const authExpiry = new AuthExpiryMarks(
        expiryFile ? homeKeyedAuthExpiryPersistence(expiryFile, harnessHomeKey) : null,
        (error) => logger.warn('agent-config: auth expiry marks could not be read or written', { error: String(error) })
      );
      const runtime = new AgentConfigRuntime({
        scope: runtimeScope,
        agentHost,
        ptySpawner: spawner,
        logger,
        hostDependencyLedger,
        authExpiry,
      });
      return withValidation(
        agentConfigRuntimeContract,
        createAgentConfigController(runtime),
        workerValidatePolicy(env)
      );
    },
    { port: options.port, exit: options.exit, logger }
  );
}
