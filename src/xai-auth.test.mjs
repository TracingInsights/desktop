import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXaiAuth } from './xai-auth.mjs';
import { createCredentialStore } from './credential-store.mjs';
import { oauthTokenResponses } from './protocols/__fixtures__/sse-traces.mjs';

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8')
};

function responseFrom(fixture) {
  return new Response(JSON.stringify(fixture.body), { status: fixture.status });
}

function makeCredentialStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tif1ai-xai-auth-'));
  const store = createCredentialStore({
    userDataDir: dir,
    safeStorage: mockSafeStorage
  });
  return { dir, store };
}

describe('xai auth (golden traces)', () => {
  test('refresh persists the golden success tokens and rolls expiresAt forward', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('xai-oauth', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        // Already past the 120 s refresh skew → must refresh.
        expiresAt: Date.now() - 1000
      });
      const auth = createXaiAuth({
        fetchImpl: async () => responseFrom(oauthTokenResponses.success),
        credentialStore: store
      });

      const result = await auth.resolveCredential();
      expect(result.ok).toBe(true);
      expect(result.credential.accessToken).toBe('at-123');
      expect(result.credential.refreshToken).toBe('rt-123');
      expect(result.credential.expiresAt).toBeGreaterThan(Date.now());
      expect(store.load('xai-oauth')?.accessToken).toBe('at-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a revoked refresh token (400) clears the credential and surfaces auth_expired', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('xai-oauth', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1000
      });
      const auth = createXaiAuth({
        fetchImpl: async () => responseFrom(oauthTokenResponses.revoked),
        credentialStore: store
      });

      const result = await auth.resolveCredential();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('auth_expired');
      expect(store.load('xai-oauth')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pollDeviceAuth maps a 429 slow_down token response', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      const auth = createXaiAuth({
        fetchImpl: async (url) => {
          if (url.endsWith('/oauth2/device/code')) {
            return new Response(
              JSON.stringify({
                device_code: 'device-code',
                user_code: 'ABCD-EFGH',
                verification_uri_complete: 'https://accounts.x.ai/device',
                interval: 5,
                expires_in: 1800
              }),
              { status: 200 }
            );
          }
          return responseFrom(oauthTokenResponses.slowDown);
        },
        credentialStore: store
      });

      const started = await auth.startDeviceAuth();
      expect(started.ok).toBe(true);
      const result = await auth.pollDeviceAuth();
      expect(result.ok).toBe(true);
      expect(result.status).toBe('slow_down');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
