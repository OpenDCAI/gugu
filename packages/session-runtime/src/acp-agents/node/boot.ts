import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { acpRuntimeApiContract } from '@gugu/session-core/acp';
import { AgentPluginHost, type CLIAgentPluginProvider } from '@gugu/session-core/agents/plugins';
import {
  createAgentHomeProvisioner,
  createLocalPluginFs,
} from '@gugu/session-core/agents/plugins/helpers';
import { diskWindowsShimReader, NodeExecutionContext } from '@gugu/session-core/exec';
import { initProcessLogging } from '@gugu/session-shared/logger/node';
import type { PluginRegistry } from '@gugu/session-shared/plugins';
import { createEventStreamHost, withValidation } from '@gugu/session-wire';
import {
  serveWorkerProcess,
  workerValidatePolicy,
  type ProcessRuntimePort,
} from '@gugu/session-wire/util/process-runtime';
import { createAcpRuntimeController } from '../api/controller';
import { AcpRuntime } from '../runtime/runtime';
import type { AcpRuntimeDeps } from '../runtime/types';
import { ChildAcpProcessHost } from './child-process-host';
import { LocalAttachmentStore } from './local-attachment-store';
import { LocalPromptQueueStore } from './local-prompt-queue-store';

export type BootAcpRuntimeProcessOptions = {
  pluginRegistry: PluginRegistry<CLIAgentPluginProvider>;
  env?: NodeJS.ProcessEnv;
  port?: ProcessRuntimePort;
  exit?: (code: number) => void;
  resolveProviderEnv?: (providerId: string) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * core 的 `mergeDeliveryEnvelopes` —— 回合期间攒下的多条信封合成一条的**唯一属主**。
   * ⚠️ **必填**:宿主忘了接线就编译不过,❌ 不留一个运行期才发现的空洞
   * (session-runtime 不依赖 `@gugu/core`,所以只能由宿主传进来)。
   */
  mergeEnvelopes: (texts: readonly string[]) => string;
};

export function bootAcpRuntimeProcess(options: BootAcpRuntimeProcessOptions): void {
  const env = options.env ?? process.env;
  const logger = initProcessLogging({ name: 'acp-agents-runtime', env });

  void serveWorkerProcess(
    (scope) => {
      const attachmentsDir = env.GUGU_ACP_ATTACHMENTS_DIR;
      if (!attachmentsDir) {
        throw new Error('ACP runtime process started without GUGU_ACP_ATTACHMENTS_DIR');
      }

      const childHost = new ChildAcpProcessHost();
      const platformSessionClosed = createEventStreamHost(
        acpRuntimeApiContract.platformSessionClosed
      );
      // #5381 会话历史落盘:回合提交推给主进程,由它决定落不落(只有它知道库里有没有)。
      const turnCommitted = createEventStreamHost(acpRuntimeApiContract.turnCommitted);
      const attachmentStore = new LocalAttachmentStore(attachmentsDir);
      const promptQueueStore = new LocalPromptQueueStore(join(attachmentsDir, 'prompt-queues'));
      const homeDir = os.homedir();
      const agentHost = new AgentPluginHost({
        windowsShimReader: diskWindowsShimReader,
        scope,
        registry: options.pluginRegistry,
        exec: new NodeExecutionContext({ env }),
        fs: createLocalPluginFs(homeDir),
        homeDir,
        // 独立 home:声明了 `configRoot` 的家读写咕咕自己那一份配置根。
        // 没有 GUGU_HOME 时返回 undefined = 整套不启用(❌ 不猜路径)。
        agentHome: createAgentHomeProvisioner(env.GUGU_HOME, homeDir, env),
        resolveProviderEnv: options.resolveProviderEnv,
      });
      const acp = new AcpRuntime({
        agentHost,
        host: childHost,
        mergeEnvelopes: options.mergeEnvelopes,
        resolveAttachment: async (attachment) => {
          if (attachment.type === 'attachment') {
            const stored = await attachmentStore.get(attachment.id);
            if (!stored) throw new Error(`Attachment '${attachment.id}' could not be resolved`);
            return {
              data: Buffer.from(stored.data).toString('base64'),
              mimeType: stored.ref.mimeType,
            };
          }
          const data = await readFile(attachment.originalPath);
          return {
            data: data.toString('base64'),
            mimeType: attachment.mimeType,
          };
        },
        attachmentStore,
        promptQueueStore,
        logger,
        onPlatformSessionClosed: (sessionId, platformAccessSessionId) =>
          platformSessionClosed.emit(undefined, {
            sessionId,
            ...(platformAccessSessionId ? { platformAccessSessionId } : {}),
          }),
        onTurnCommitted: (event) => turnCommitted.emit(undefined, event),
      } satisfies AcpRuntimeDeps);

      scope.add(() => platformSessionClosed.dispose());
      scope.add(() => turnCommitted.dispose());
      scope.add(() => acp.dispose());
      return withValidation(
        acpRuntimeApiContract,
        createAcpRuntimeController(acp, platformSessionClosed, turnCommitted),
        workerValidatePolicy(env)
      );
    },
    { port: options.port, exit: options.exit, logger }
  );
}
