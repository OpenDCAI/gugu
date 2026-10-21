import { describe, expect, it } from 'vitest';
import enUSCommon from '@/i18n/locales/en-US/common';
import zhCNCommon from '@/i18n/locales/zh-CN/common';
import { AGENT_STATUS_LABELS } from '@gugu/core/shared/agentStatusPresentation';
import { enUSMessages, zhCNMessages } from './messages';

// #6448 owner 2026-09-25:会话页、聊天、手机说同一张表。会话页目录里的那一句取自咕咕 common:agentStatus,
// 这条钉住「取自」而不是「抄了一份」:每个 label 两边逐字相同。
describe('agent status words: the task page reads the one table', () => {
  it.each(AGENT_STATUS_LABELS)('%s', (label) => {
    expect(zhCNMessages[`agentStatus.${label}`]).toBe(zhCNCommon.agentStatus[label]);
    expect(enUSMessages[`agentStatus.${label}`]).toBe(enUSCommon.agentStatus[label]);
    expect(zhCNMessages[`agentStatus.${label}`]).toBeTruthy();
  });

  it('matches the owner table', () => {
    expect(zhCNCommon.agentStatus).toMatchObject({
      running: '运行中',
      parked: '后台运行中',
      needsApproval: '等你批准',
      needsAnswer: '等你回答',
      needsPlanReview: '等你看计划',
      needsAction: '需要你处理',
      error: '出错了',
      done: '做完了',
      idle: '空闲',
      online: '在线',
    });
    expect(enUSCommon.agentStatus).toMatchObject({
      running: 'Running',
      parked: 'Running in background',
      needsApproval: 'Needs your approval',
      needsAnswer: 'Needs your answer',
      needsPlanReview: 'Needs your plan review',
      needsAction: 'Needs your action',
      error: 'Error',
      done: 'Done',
      online: 'Online',
    });
  });

  it('the sidebar section title says the same word as the cells', () => {
    expect(zhCNMessages['sidebar.working']).toBe(zhCNCommon.agentStatus.running);
    expect(enUSMessages['sidebar.working']).toBe(enUSCommon.agentStatus.running);
  });
});
