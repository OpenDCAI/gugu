import { describe, expect, it } from 'vitest';
import {
  carryEffort,
  planTerminalEffortSwitch,
  planTerminalModelSwitch,
  terminalSelectedOptionId,
} from './terminal-model-switch';

const options = {
  'platform:gemini-3.7-pro': { name: 'Gemini 3.7 Pro' },
  'platform:glm-5.2': { name: 'GLM 5.2' },
  'opus[1m]': { name: 'Opus (1M)' },
  sonnet: { name: 'Sonnet', disabled: true },
};

describe('terminalSelectedOptionId', () => {
  it('highlights the platform model the conversation recorded', () => {
    expect(terminalSelectedOptionId({
      sessionSelection: { modelId: 'glm-5.2' },
      platformModelIds: ['glm-5.2', 'gemini-3.7-pro'],
      recordedModel: 'opus[1m]',
    })).toBe('platform:glm-5.2');
  });

  it('highlights the recorded own model on an explicit BYOK conversation', () => {
    expect(terminalSelectedOptionId({
      sessionSelection: null,
      platformModelIds: ['glm-5.2'],
      recordedModel: 'opus[1m]',
    })).toBe('opus[1m]');
  });

  it('highlights nothing when the conversation runs on the harness default', () => {
    expect(terminalSelectedOptionId({
      sessionSelection: null,
      platformModelIds: [],
      recordedModel: '  ',
    })).toBeUndefined();
  });
});

describe('planTerminalModelSwitch', () => {
  it('switches an own-model session to a Gugu model with the platform billing path', () => {
    expect(planTerminalModelSwitch({
      optionId: 'platform:gemini-3.7-pro',
      selectedOptionId: 'opus[1m]',
      options,
    })).toEqual({ kind: 'reload', model: { id: 'gemini-3.7-pro', source: 'platform' }, label: 'Gemini 3.7 Pro' });
  });

  it('switches a Gugu-model session back to an own model with the own billing path', () => {
    expect(planTerminalModelSwitch({
      optionId: 'opus[1m]',
      selectedOptionId: 'platform:glm-5.2',
      options,
    })).toEqual({ kind: 'reload', model: { id: 'opus[1m]', source: 'own' }, label: 'Opus (1M)' });
  });

  it('reloads for a switch within the Gugu tier too — a terminal session has no hot switch', () => {
    expect(planTerminalModelSwitch({
      optionId: 'platform:gemini-3.7-pro',
      selectedOptionId: 'platform:glm-5.2',
      options,
    })).toMatchObject({ kind: 'reload', model: { id: 'gemini-3.7-pro', source: 'platform' } });
  });

  it('does not interrupt the session when the running model is picked again', () => {
    expect(planTerminalModelSwitch({
      optionId: 'platform:glm-5.2',
      selectedOptionId: 'platform:glm-5.2',
      options,
    })).toEqual({ kind: 'none' });
  });

  it('ignores disabled or unknown options', () => {
    expect(planTerminalModelSwitch({ optionId: 'sonnet', selectedOptionId: undefined, options }))
      .toEqual({ kind: 'none' });
    expect(planTerminalModelSwitch({ optionId: 'platform:gone', selectedOptionId: undefined, options }))
      .toEqual({ kind: 'none' });
    expect(planTerminalModelSwitch({ optionId: 'opus[1m]', selectedOptionId: undefined, options: null }))
      .toEqual({ kind: 'none' });
  });
});

describe('carryEffort — thinking level across a model switch', () => {
  it('keeps the recorded level when the new model has it', () => {
    expect(carryEffort('high', ['low', 'medium', 'high'])).toBeUndefined();
  });

  it('clears a level the new model does not accept', () => {
    expect(carryEffort('max', ['low', 'medium', 'high'])).toBeNull();
    expect(carryEffort('high', null)).toBeNull();
  });

  it('leaves an unset level alone', () => {
    expect(carryEffort(undefined, ['low'])).toBeUndefined();
    expect(carryEffort('  ', null)).toBeUndefined();
  });

  it('rides along on the model switch plan', () => {
    expect(planTerminalModelSwitch({
      optionId: 'platform:glm-5.2',
      selectedOptionId: 'opus[1m]',
      options,
      recordedEffort: 'max',
      targetEffortIds: ['low', 'high'],
    })).toMatchObject({ kind: 'reload', effort: null });
  });
});

describe('planTerminalEffortSwitch', () => {
  const efforts = { low: { name: 'Low' }, high: { name: 'High' }, max: { name: 'Max', disabled: true } };

  it('reloads with the picked level, model untouched', () => {
    expect(planTerminalEffortSwitch({ effortId: 'high', recordedEffort: 'low', options: efforts }))
      .toEqual({ kind: 'reload', effort: 'high', effortName: 'High' });
  });

  it('does not interrupt for the level already running, or a disabled/unknown one', () => {
    expect(planTerminalEffortSwitch({ effortId: 'low', recordedEffort: 'low', options: efforts })).toEqual({ kind: 'none' });
    expect(planTerminalEffortSwitch({ effortId: 'max', recordedEffort: 'low', options: efforts })).toEqual({ kind: 'none' });
    expect(planTerminalEffortSwitch({ effortId: 'x', recordedEffort: null, options: efforts })).toEqual({ kind: 'none' });
  });

  it('treats the reset button as clearing back to the default', () => {
    expect(planTerminalEffortSwitch({ effortId: '', recordedEffort: 'high', options: efforts }))
      .toEqual({ kind: 'reload', effort: null, effortName: null });
    expect(planTerminalEffortSwitch({ effortId: '', recordedEffort: undefined, options: efforts }))
      .toEqual({ kind: 'none' });
    // ACP 报的「default」档 = harness 默认;claude 的 `--effort default` 会被当未知值忽略
    expect(planTerminalEffortSwitch({ effortId: 'default', recordedEffort: 'high', options: { ...efforts, default: { name: 'Default' } } }))
      .toEqual({ kind: 'reload', effort: null, effortName: null });
  });
});
