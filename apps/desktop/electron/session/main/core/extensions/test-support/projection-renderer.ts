import { mountProjection } from '../../../../../../src/session/app-runtime/projection-view';
import type { ProjectionHost } from '../../../../../../src/session/app-runtime/projection-source';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';

type Fixture = { call(method: string, args: unknown): Promise<never>; hear(callback: (watch: string, packet: ProjectionHostPacket) => void): () => void };
const fixture = (window as unknown as { fixture: Fixture }).fixture;
const host: ProjectionHost = {
  projection: {
    create: args => fixture.call('create', args), publish: args => fixture.call('publish', args), close: args => fixture.call('close', args),
    closed: args => fixture.call('closed', args), inputResult: args => fixture.call('inputResult', args),
    watch: args => { Object.assign(window, { fixtureWatchId: args.watchId }); return fixture.call('watch', args); }, unwatch: args => fixture.call('unwatch', args), send: args => fixture.call('send', args),
  },
  onProjection: callback => fixture.hear(callback),
};
const state = { value: '', error: '' };
Object.assign(window, { projectionState: state });
void mountProjection(host, document.getElementById('projection')!, new URLSearchParams(location.search).get('id')!, {
  state: value => { state.value = value; },
  error: error => { state.error = String(error); },
}).catch(error => { state.error = String(error); });
