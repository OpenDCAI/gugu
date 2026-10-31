import { randomUUID } from 'node:crypto';
import { permissionModeFromAutoApprove } from '@gugu/session-core/acp';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { err, ok, type Result } from '@gugu/session-shared';
import { issueController } from '@main/core/issues/controller';
import { openProject } from '@main/core/projects/operations/openProject';
import { projectManager } from '@main/core/projects/project-manager';
import { classifyCreateFailure } from '@main/core/session-timeline/create-failure';
import { launchCreatedSession } from '@main/core/session-timeline/launch-created-session';
import { recordStartFailure } from '@main/core/session-timeline/start-failures';
import { generateRandom } from '@main/core/sessions/name-generation/generateSessionName';
import {
  commitCreateSession,
  finalizeCreateSession,
  prepareCreateSession,
} from '@main/core/sessions/operations/createSession';
import { sessionService } from '@main/core/sessions/session-service';
import { db } from '@main/db/client';
import type { SessionRow } from '@main/db/schema';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import type { AgentConfig } from '@shared/core/automations/config';
import {
  buildInitialSessionDocument,
  type InitialSessionDocument,
} from '@shared/core/sessions/initial-session-document';
import {
  sessionViewOfRuntime,
  type InitialQueuePrompt,
} from '@shared/core/sessions/sessions';
import {
  buildIssueMentionContextBlock,
  buildIssueMentionHiddenContext,
  issueMentionToken,
} from '@shared/core/issues/issue-context';
import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { assertValidAutomationInput } from '../repo';
import {
  markRunStartingAgent,
  markRunFailed,
  markRunLaunchingSession,
  type OnStepCompleted,
} from '../run-transitions';

async function ensureProjectOpen(projectId: string) {
  let project = projectManager.getProject(projectId);
  if (!project) {
    const openResult = await openProject(projectId);
    if (!openResult.success) return err('project_not_found' as const);
    project = projectManager.getProject(projectId);
    if (!project) return err('project_not_found' as const);
  }

  return ok(project);
}

async function buildAutomationInitialQueue(
  automation: Automation,
  projectId: string,
  prompt: string
): Promise<InitialQueuePrompt[]> {
  const hiddenContextParts: string[] = [];
  const linkedIssue = automation.sessionConfig?.sessionConfig.linkedIssue;
  if (linkedIssue) {
    hiddenContextParts.push(
      buildIssueMentionContextBlock(
        {
          token: issueMentionToken(linkedIssue.provider, linkedIssue.identifier),
          provider: linkedIssue.provider,
          identifier: linkedIssue.identifier,
        },
        linkedIssue
      )
    );
  }

  const mentionContext = await buildIssueMentionHiddenContext(prompt, async (target) => {
    const result = await issueController.getIssueContext(target.provider, {
      identifier: target.identifier,
      projectId,
    });
    return result.success ? result.data : null;
  });
  if (mentionContext) hiddenContextParts.push(mentionContext);

  const hiddenContext = hiddenContextParts.join('\n\n').trim();
  return [
    {
      text: prompt,
      ...(hiddenContext && { hiddenContext }),
      origin: 'manual',
    },
  ];
}

/**
 * 「已安排」到点开出来的那条会话 = 新建会话那份文档(`buildInitialSessionDocument`,桌面 composer 与
 * 手机新建页共用的同一个翻译点),再加上调度器自己的两件事:会话名是那条自动化的名字(人起的,harness
 * 自己拟的名不盖它);第一句话作为系统启动载荷随首次启动交出去(没人守在会话页替它发)。
 *
 * ❌ 别在这里另拼一份会话:原来这条路用 attachAgentToSession 手拼会话行、再手写 ACP 启动入参,
 * 平台模型与权限档两维在那份里根本没有位置 —— composer 上选了咕咕的模型,到点跑的却是 agent 级默认。
 */
export function automationInitialSession(
  automation: Pick<Automation, 'name'>,
  config: AgentConfig,
  input: { sessionId: string; prompt: string; initialQueue: InitialQueuePrompt[] | undefined }
): InitialSessionDocument {
  const runtime = config.type ?? 'pty';
  const platformModel = config.platformModel;
  return {
    ...buildInitialSessionDocument({
      id: input.sessionId,
      // ⚠️ 这里**没有第二份默认值**,是故意的(#5973,owner 2026-09-21 要求与界面对齐)。
      // 从前这一行是 `provider || 设置里的默认 Agent || DEFAULT_AGENT_ID(=claude)`,与界面创建器
      // 那串偏好(Codex → Claude,且看本机装没装)正面分叉。查下来后两档**根本走不到**:
      // `agentConfig.provider` 是必填(config.ts 的 zod `z.string()`),而 executeSessionCreate 开头那句
      // `assertValidAutomationInput` 又要求它是一个已注册、且支持无人值守的 provider ——
      // 空值在挑默认值之前就被挡下了。⇒ 对齐的做法是**把那两档删掉**,而不是再抄一份偏好:
      // 同一条规则存两份,迟早在某一次改动里分叉,而这一份还没有任何路径会执行到。
      // 校验放松的那天,`sessionCreate.test.ts` 里那条「没存 Agent 的自动化被挡下」会变红。
      provider: config.provider as AgentProviderId,
      sessionView: sessionViewOfRuntime(runtime),
      prompt: input.prompt,
      // 存下来的只有「无人值守」那一个布尔(校验要求它为真),档位由它派生 —— 与启动入参同一条换算。
      permissionMode: permissionModeFromAutoApprove(config.autoApprove),
      // 选了平台模型时 harness 那一格必须空(模型由网关 token 钉死),❌ 让两者同时说话。
      model: platformModel ? null : config.model || null,
      effort: config.effort || null,
      // 三态原样往下传:缺席(旧记录)= 回落 agent 级;null = harness 自家;对象 = 平台模型。
      ...(platformModel !== undefined ? { platformModel } : {}),
    }),
    title: config.title ?? automation.name,
    titleSource: 'manual',
    ...(runtime === 'acp' ? { initialQueue: input.initialQueue } : { initialPrompt: input.prompt }),
  };
}

export async function executeSessionCreate(
  automation: Automation,
  run: AutomationRun,
  onStepCompleted: OnStepCompleted
): Promise<Result<{ sessionId: string }, string>> {
  const prompt = automation.agentConfig?.prompt.trim();
  if (!prompt) return err('task_create_prompt_empty');
  if (!automation.triggerConfig || !automation.agentConfig) {
    return err('automation_config_required');
  }

  const projectId = automation.projectId;
  if (!projectId) return err('no_project_attached');

  try {
    assertValidAutomationInput({
      triggerConfig: automation.triggerConfig,
      agentConfig: automation.agentConfig,
    });
    const sessionConfig = automation.sessionConfig;
    const sessionId = randomUUID();
    const sessionName = run.generatedSessionName ?? generateRandom();

    const projectResult = await ensureProjectOpen(projectId);
    if (!projectResult.success) {
      const failed = await markRunFailed(run.id, {
        step: 'create_session',
        code: 'project_not_found',
      });
      onStepCompleted(failed);
      return err(projectResult.error);
    }

    if (!sessionConfig?.workspaceConfig) {
      const failed = await markRunFailed(run.id, {
        step: 'create_session',
        code: 'no_workspace_config',
      });
      onStepCompleted(failed);
      return err('no_workspace_config');
    }
    const workspaceConfig = sessionConfig.workspaceConfig;

    const sessionRuntime = automation.agentConfig.type ?? 'pty';
    // Automation work is scheduler-owned system bootstrap, not user text from a create surface.
    const initialQueue =
      sessionRuntime === 'acp'
        ? await buildAutomationInitialQueue(automation, projectId, prompt)
        : undefined;
    const initialSession = automationInitialSession(automation, automation.agentConfig, {
      sessionId,
      prompt,
      initialQueue,
    });

    const createSessionParams: CreateSessionParams = {
      projectId,
      sessionConfig: {
        version: '1',
        name: sessionName,
        linkedIssue: sessionConfig?.sessionConfig.linkedIssue,
        // 与桌面 composer、别的机器建会话同一条 prepareCreateSession 管线:平台模型的选择、权限档、
        // 引擎能不能起的预检都在这一步。
        initialSession,
      },
      workspaceConfig,
      automationRunId: run.id,
    };

    const prepared = await prepareCreateSession(createSessionParams);
    if (!prepared.success) {
      const error = prepared.error;
      let runError: Parameters<typeof markRunFailed>[1];
      switch (error.type) {
        case 'project-not-found':
          runError = { step: 'create_session', code: 'project_not_found' };
          break;
        case 'provision-failed':
          runError = { step: 'create_session', code: 'provision_failed', message: error.message };
          break;
        // @@@5173 引擎起不来 ⇒ 会话根本没建。自动化跑到这里要记下是哪一种:
        // 正在被替换的下次触发多半就好了,真没装的每次都会失败 —— 落进 unknown 就把这个区别丢了。
        case 'harness-unavailable':
          runError = {
            step: 'create_session',
            code: `harness_${error.reason}`,
            message: error.detail,
          };
          break;
        case 'provision-timeout':
          runError = {
            step: 'create_session',
            code: 'provision_timeout',
            message: String(error.timeoutMs),
          };
          break;
        default:
          runError = { step: 'create_session', code: 'unknown' };
      }
      const failed = await markRunFailed(run.id, runError);
      onStepCompleted(failed);
      return err(error.type);
    }

    let convRow!: SessionRow;
    db.transaction((tx) => {
      convRow = commitCreateSession(prepared.data, tx);
    });
    finalizeCreateSession(prepared.data, convRow);

    const launching = await markRunLaunchingSession(run.id, Date.now());
    onStepCompleted(launching);

    // 挂工作区、起 agent:与别的机器 / 手机建会话同一份(`launchCreatedSession`)。
    // 工作区挂好的那一刻就是运行记录里「在建会话」这一步的起点。
    let setupFailure: string | undefined;
    const launched = await launchCreatedSession({
      sessionId,
      projectId,
      runtime: sessionRuntime,
      launchWorkspace: async () => {
        const provision = await sessionService.provisionWorkspace(sessionId);
        if (!provision.success) {
          if (provision.error.type === 'setup-failed') setupFailure = provision.error.message;
          return provision;
        }
        const creatingConv = await markRunStartingAgent(run.id, Date.now());
        onStepCompleted(creatingConv);
        return provision;
      },
    });
    if (!launched.ok) {
      // 会话行已经写下了:它照样打得开(spec session-always-openable),没起来的原因记在会话上,
      // 打开时转录末尾那一行说清、可以再试一次 —— 与别的机器建会话同一个原因码表。
      recordStartFailure(
        sessionId,
        classifyCreateFailure(launched.code, launched.detail, {
          platformModel: !!initialSession.platformModel,
        })
      );
      const failed = await markRunFailed(
        run.id,
        launched.code === 'provision_failed'
          ? { step: 'launch_session', code: 'provision_failed', message: setupFailure }
          : { step: 'start_agent', code: 'failed', message: launched.detail }
      );
      onStepCompleted(failed);
      return err(launched.code === 'provision_failed' ? 'provision_failed' : launched.detail);
    }

    return ok({ sessionId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const failed = await markRunFailed(run.id, {
      step: 'create_session',
      code: 'unknown',
      message: msg,
    });
    onStepCompleted(failed);
    return err(msg);
  }
}
