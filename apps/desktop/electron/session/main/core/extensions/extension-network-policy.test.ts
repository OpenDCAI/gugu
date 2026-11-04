import { describe, expect, it } from 'vitest';
import { decideExtensionRequest } from './extension-network-policy';

describe('network refusal explains the current grant', () => {
  const declared = ['api.example.com', '*.withdrawn.example.com'];
  const granted = ['api.example.com'];

  it('distinguishes a withdrawn declaration from a host never declared', () => {
    expect(decideExtensionRequest('https://data.withdrawn.example.com', granted, declared))
      .toEqual({ allowed: false, reason: 'host-withdrawn' });
    expect(decideExtensionRequest('https://other.example.org', granted, declared))
      .toEqual({ allowed: false, reason: 'host-not-declared' });
    expect(decideExtensionRequest('https://api.example.com', granted, declared))
      .toEqual({ allowed: true });
  });

  it('still rejects local hosts before considering their declarations', () => {
    expect(decideExtensionRequest('https://127.0.0.1', ['127.0.0.1'], ['127.0.0.1']))
      .toEqual({ allowed: false, reason: 'local-host' });
  });
});
