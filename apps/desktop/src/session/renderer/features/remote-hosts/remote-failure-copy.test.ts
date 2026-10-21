import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { describeRemoteCreateFailure, remoteErrorCode, remoteStartCondition } from './remote-failure-copy';

/** 假翻译:key + 插值,够看出选了哪一句、带没带机器名。 */
const translate = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(',')})` : key;

const RAW = 'error sending request for url (http://gugu-newapi:3000/api/status): client error (Connect): dns error';

function turnWithReply(text: string): TranscriptTurn {
  return {
    id: 't1',
    seq: 1,
    initiator: 'user',
    items: [
      { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'hi' },
      { kind: 'message', id: 'a', seq: 1, role: 'assistant', text },
    ],
  };
}

describe('describeRemoteCreateFailure(输入框下那一句)', () => {
  it('咕咕模型服务连不上:说是哪台机器、查它的网络,❌ 带网关原文', () => {
    const text = describeRemoteCreateFailure('platform_model_unreachable', '走查机', translate as never);
    expect(text).toBe('remoteFailure.modelServiceUnreachable(device=走查机)');
    expect(text).not.toContain('gugu-newapi');
  });

  it('认不出的码说「没开起来」;没有码(超时、频道没开)说「那台机器没回应」', () => {
    expect(describeRemoteCreateFailure('create_task_failed', 'm', translate as never)).toBe('remoteFailure.startFailed(device=m)');
    expect(describeRemoteCreateFailure(null, 'm', translate as never)).toBe('remoteFailure.machineUnreachable(device=m)');
  });

  it('错误码按形状读', () => {
    expect(remoteErrorCode(Object.assign(new Error(RAW), { code: 'platform_model_unreachable' }))).toBe('platform_model_unreachable');
    expect(remoteErrorCode(new Error('timeout'))).toBeNull();
  });
});

describe('remoteStartCondition(会话打开后转录末尾那一行)', () => {
  const base = { turns: [] as TranscriptTurn[], device: '走查机', agent: 'Codex', translate: translate as never };

  it('还没开起来:按机器记下的原因码说人话 + 再试一次;悬停只放原因码', () => {
    expect(
      remoteStartCondition({ ...base, summary: { recordState: 'not-started', startFailure: 'platform_model_unreachable' }, retry: { phase: 'idle' } })
    ).toEqual({
      code: 'start-failed',
      label: 'remoteCondition.modelServiceUnreachable(device=走查机,agent=Codex)',
      detail: 'platform_model_unreachable',
      retry: true,
    });
  });

  it('没记下原因(老会话)或原因没有专门的说法:通用那句,照样能再试', () => {
    expect(remoteStartCondition({ ...base, summary: { recordState: 'not-started' }, retry: { phase: 'idle' } })).toMatchObject({
      label: 'remoteCondition.startFailed(device=走查机,agent=Codex)',
      retry: true,
    });
  });

  it('正在重试:只说正在重新开,不摆动作;重试又失败:换成机器新报的原因', () => {
    const summary = { recordState: 'not-started' as const, startFailure: 'session_start_failed' };
    expect(remoteStartCondition({ ...base, summary, retry: { phase: 'running' } })).toMatchObject({
      label: 'remoteCondition.retrying(device=走查机)',
      retry: false,
    });
    expect(remoteStartCondition({ ...base, summary, retry: { phase: 'failed', code: 'agent_signed_out' } })).toMatchObject({
      label: 'remoteCondition.agentSignedOut(device=走查机,agent=Codex)',
      retry: true,
    });
    // 重试成功:摘要还没跟上之前,这一行先收起来。
    expect(remoteStartCondition({ ...base, summary, retry: { phase: 'succeeded' } })).toBeNull();
  });

  it('这一家的记录没接:说到那台机器上去看,不给动作(重试修不好它)', () => {
    expect(remoteStartCondition({ ...base, summary: { recordState: 'harness-unsupported' }, retry: { phase: 'idle' } })).toMatchObject({
      code: 'harness-missing',
      retry: false,
    });
  });

  it('agent 最近一句回复是「没登录」:指到那台机器上去登录;后面好了就不再挂', () => {
    const signedOut = turnWithReply('Not logged in · Please run /login');
    expect(remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [signedOut] })).toMatchObject({
      code: 'auth-required',
      label: 'remoteCondition.agentSignedOutReply(device=走查机,agent=Codex)',
      retry: false,
    });
    const later = { ...turnWithReply('好的,红色'), id: 't2', seq: 2 };
    expect(remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [signedOut, later] })).toBeNull();
  });

  it('#6264 没登录、而这里登得了:句子里那段字就是「在这里登录」;没开起来的那条登完顺手重开', () => {
    const signedOut = turnWithReply('Not logged in · Please run /login');
    expect(remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [signedOut], signIn: 'here' })).toEqual({
      code: 'auth-required',
      label: 'remoteCondition.agentSignedOutLead(device=走查机,agent=Codex)',
      detail: 'Not logged in · Please run /login',
      retry: false,
      signIn: { label: 'remoteCondition.signInHere', restart: false },
    });
    // 只能到那台机器的终端里登:那段字换成「看看怎么登」。
    expect(
      remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [signedOut], signIn: 'instructions' })?.signIn
    ).toEqual({ label: 'remoteCondition.signInHow', restart: false });
    // 登上了:那一行改说「已登录,再发一次」,不再给动作。
    expect(
      remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [signedOut], signIn: 'here', signedIn: true })
    ).toEqual({
      code: 'auth-required',
      label: 'remoteCondition.signedInSendAgain(device=走查机,agent=Codex)',
      detail: 'Not logged in · Please run /login',
      retry: false,
    });
    // 会话没开起来、原因是没登录:登录并重新开始,❌ 再挂一段「再试一次」。
    expect(
      remoteStartCondition({
        ...base,
        summary: { recordState: 'not-started', startFailure: 'agent_signed_out' },
        retry: { phase: 'idle' },
        signIn: 'here',
      })
    ).toMatchObject({ retry: false, signIn: { label: 'remoteCondition.signInAndRestart', restart: true } });
    // 这里登不了(产品里没有这家的登录动作):照旧只说事实。
    expect(
      remoteStartCondition({ ...base, summary: { recordState: 'not-started', startFailure: 'agent_signed_out' }, retry: { phase: 'idle' } })
    ).toMatchObject({ label: 'remoteCondition.agentSignedOut(device=走查机,agent=Codex)', retry: true });
  });

  it('#6264 最近一轮因登录失效而失败(结构化那一格):「登录已失效」+ 在这里重新登录;之后又有一轮就不再挂', () => {
    const failed: TranscriptTurn = {
      ...turnWithReply(''),
      items: [{ kind: 'message', id: 'u', seq: 0, role: 'user', text: 'hi' }],
      outcome: { kind: 'error', reason: 'prompt_failed', signInRequired: true, detail: 'could not be refreshed' },
    };
    expect(remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [failed], signIn: 'here' })).toEqual({
      code: 'auth-required',
      label: 'remoteCondition.agentSignInExpiredLead(device=走查机,agent=Codex)',
      detail: 'sign-in-expired',
      retry: false,
      signIn: { label: 'remoteCondition.signInHere', restart: false },
    });
    // 这里登不了:只说事实,指到那台机器上去重新登录。
    expect(remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [failed] })).toMatchObject({
      label: 'remoteCondition.agentSignInExpired(device=走查机,agent=Codex)',
    });
    expect(
      remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [failed], signIn: 'here', signedIn: true })
    ).toMatchObject({ label: 'remoteCondition.signedInSendAgain(device=走查机,agent=Codex)' });
    const later: TranscriptTurn = { ...turnWithReply('好的'), id: 't2', seq: 2, outcome: { kind: 'done' } };
    expect(remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [failed, later], signIn: 'here' })).toBeNull();
  });

  it('#6264 那台机器报这家登录已失效(转录里看不出失败):同样挂「登录已失效」+ 在这里重新登录', () => {
    expect(
      remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' }, turns: [], signIn: 'here', harnessExpired: true })
    ).toMatchObject({
      code: 'auth-required',
      label: 'remoteCondition.agentSignInExpiredLead(device=走查机,agent=Codex)',
      signIn: { label: 'remoteCondition.signInHere', restart: false },
    });
  });

  it('一切正常:不挂', () => {
    expect(remoteStartCondition({ ...base, summary: null, retry: { phase: 'idle' } })).toBeNull();
  });
});
