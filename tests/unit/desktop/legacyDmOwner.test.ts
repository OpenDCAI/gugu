// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createNode, createReactHarness } from '../../support/testHarness';
import { publishRendererSession } from '../../../apps/desktop/src/lib/sessionPublication';
import { useLegacyDmOwner } from '../../../apps/desktop/src/components/legacy-dm-history/useLegacyDmOwner';

const harness = createReactHarness();
afterEach(() => { harness.cleanup(); publishRendererSession('SIGNED_OUT', null); });

it('reads the published owner in a separate session root without AuthContext and follows account changes', async () => {
  function Probe() { return createNode('span', null, useLegacyDmOwner() ?? 'signed out'); }
  await harness.render(createNode(Probe));
  expect(harness.container.textContent).toBe('signed out');
  await act(async () => { publishRendererSession('SIGNED_IN', {user:{id:'owner-one'}} as never); });
  expect(harness.container.textContent).toBe('owner-one');
  await act(async () => { publishRendererSession('SIGNED_IN', {user:{id:'owner-two'}} as never); });
  expect(harness.container.textContent).toBe('owner-two');
  await act(async () => { publishRendererSession('SIGNED_OUT', null); });
  expect(harness.container.textContent).toBe('signed out');
});
