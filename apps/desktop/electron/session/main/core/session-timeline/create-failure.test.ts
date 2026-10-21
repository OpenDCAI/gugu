import { describe, expect, it } from 'vitest';
import { remoteFailureKind } from '@gugu/session-core/session-record/contract';
import { classifyCreateFailure } from './create-failure';

describe('classifyCreateFailure(原文 → 发起方认得出的原因码)', () => {
  const gateway =
    'error sending request for url (http://gugu-newapi:3000/api/status): client error (Connect): dns error: failed to lookup address information';

  it('选了咕咕提供的模型、连不上模型服务 → platform_model_unreachable', () => {
    expect(classifyCreateFailure('session_start_failed', gateway, { platformModel: true })).toBe('platform_model_unreachable');
    expect(classifyCreateFailure('model_rejected', 'TypeError: fetch failed', { platformModel: true })).toBe('platform_model_unreachable');
    // 自带模型的会话不经过签平台额度那一趟:同样的网络原文不认成它。
    expect(classifyCreateFailure('session_start_failed', gateway, { platformModel: false })).toBe('session_start_failed');
  });

  // #7103 别的电脑上:宿主已经报了原因码的,原样交给发起方按原因表说,❌ 一律说成「连不上咕咕模型服务」。
  it('带原因码的失败 → 原样把码交给发起方', () => {
    const wrapped = "Error invoking remote method 'pty:start': Error: gugu-models:membership-required";
    expect(classifyCreateFailure('session_start_failed', wrapped, { platformModel: true })).toBe('gugu-models:membership-required');
    expect(classifyCreateFailure('model_rejected', 'gugu-models:service-unavailable', { platformModel: true })).toBe('gugu-models:service-unavailable');
    // 不是这几步的码(已经说清是哪一步)照旧不动。
    expect(classifyCreateFailure('project_not_found', 'gugu-models:signed-out', { platformModel: true })).toBe('project_not_found');
  });

  it('agent 没登录 → agent_signed_out', () => {
    expect(classifyCreateFailure('session_start_failed', 'Not logged in · Please run /login', { platformModel: false })).toBe(
      'agent_signed_out'
    );
  });

  it('模块解析不到 → harness_runtime_missing(哪一步都算)', () => {
    expect(classifyCreateFailure('provision_failed', "Cannot find module 'x'", { platformModel: false })).toBe('harness_runtime_missing');
  });

  it('已经说清是哪一步的码不动;认不出的原文保持原码', () => {
    expect(classifyCreateFailure('project_not_found', gateway, { platformModel: true })).toBe('project_not_found');
    expect(classifyCreateFailure('session_start_failed', 'spawn EACCES', { platformModel: true })).toBe('session_start_failed');
  });

  it('每个原因码都落到一类人话上;认不出的归「没开起来」,传输层失败归「问不到那台机器」', () => {
    expect(remoteFailureKind('platform_model_unreachable')).toBe('model-service-unreachable');
    expect(remoteFailureKind('agent_signed_out')).toBe('agent-signed-out');
    expect(remoteFailureKind('harness_install_failed')).toBe('agent-install-failed');
    expect(remoteFailureKind('project_open_failed')).toBe('folder-unavailable');
    expect(remoteFailureKind('something_new')).toBe('start-failed');
    expect(remoteFailureKind(null)).toBe('machine-unreachable');
  });
});
