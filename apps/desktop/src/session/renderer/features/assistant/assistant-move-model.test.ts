import { expect, it } from 'vitest';
import { cloudMoveModel, moveModelSelection, sameMoveModel } from './assistant-move-model';
const protocol = 'anthropic-messages';
it('automatically uses Gugu GLM on cloud for local subscriptions and defaults, preserving explicit Gugu choices', () => {
  const glm = { source: 'platform', modelId: 'glm-5.3-flash', protocol };
  expect(cloudMoveModel({ source: 'byok', modelId: 'sonnet' }, protocol)).toEqual(glm);
  expect(cloudMoveModel({ source: 'default' }, protocol)).toEqual(glm);
  expect(cloudMoveModel({ source: 'platform', modelId: 'gpt-6.1-sol', protocol }, protocol)).toEqual({ ...glm, modelId: 'gpt-6.1-sol' });
});
it('preserves explicit model and billing source across devices', () => {
  const desired = { source: 'platform', modelId: 'glm-5.3-flash', protocol } as const;
  expect(moveModelSelection(desired, {}, protocol)).toBe(desired);
  expect(sameMoveModel(desired, { source: 'byok', modelId: desired.modelId })).toBe(false);
  expect(sameMoveModel(desired, desired)).toBe(true);
  expect(sameMoveModel(desired, null)).toBe(false);
});
it('resolves an original configuration from the source session instead of the target default', () => {
  expect(moveModelSelection({ source: 'default' }, { modelMenu: { conversationSelection: { modelId: 'glm-5.3-flash' } } }, protocol))
    .toEqual({ source: 'platform', modelId: 'glm-5.3-flash', protocol });
  expect(moveModelSelection({ source: 'default' }, { modelMenu: { conversationSelection: null }, model: { selected: 'sonnet' } }, protocol))
    .toEqual({ source: 'byok', modelId: 'sonnet' });
  expect(() => moveModelSelection({ source: 'default' }, {}, protocol)).toThrow('source home');
});
