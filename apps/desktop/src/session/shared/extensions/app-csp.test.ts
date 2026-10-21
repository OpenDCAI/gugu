import { describe, expect, it } from 'vitest';
import { extensionContentSecurityPolicy } from './app-csp';

// Moved here from main's extension-protocol.ts so the phone's shell serves an App the very same policy (L9); the
// desktop's output is pinned byte for byte (its served header is also checked end to end in extension-session.test.ts).

describe('extensionContentSecurityPolicy', () => {
  it('is the desktop policy, byte for byte: the App code only from itself, declared hosts for data, framed by one origin', () => {
    expect(extensionContentSecurityPolicy('gugu-ext://notes', ['api.example.com', '*.cdn.example.com'])).toBe(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https://api.example.com https://*.cdn.example.com https://cdn.example.com data: blob:",
        "font-src 'self' https://api.example.com https://*.cdn.example.com https://cdn.example.com data:",
        "media-src 'self' https://api.example.com https://*.cdn.example.com https://cdn.example.com blob:",
        "connect-src 'self' https://api.example.com https://*.cdn.example.com https://cdn.example.com wss://api.example.com wss://*.cdn.example.com wss://cdn.example.com",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        'frame-ancestors gugu-ext://notes',
      ].join('; '),
    );
  });

  it('on the phone only who may frame it differs: the gugu page', () => {
    expect(extensionContentSecurityPolicy('https://localhost', [])).toMatch(/frame-ancestors https:\/\/localhost$/);
    expect(extensionContentSecurityPolicy('https://localhost', [])).toContain("connect-src 'self';");
  });
});
