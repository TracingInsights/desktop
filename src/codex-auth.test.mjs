import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAuth } from './codex-auth.mjs';
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
  const dir = mkdtempSync(join(tmpdir(), 'tif1ai-codex-auth-'));
  const store = createCredentialStore({
    userDataDir: dir,
    safeStorage: mockSafeStorage
  });
  return { dir, store };
}

describe('codex auth (golden traces)', () => {
  test('refresh persists the golden success tokens and rolls expiresAt forward', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('codex', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        accountId: 'old-act',
        // Already past the 60 s refresh skew → must refresh.
        expiresAt: Date.now() - 1000
      });
      const auth = createCodexAuth({
        fetchImpl: async () => responseFrom(oauthTokenResponses.success),
        credentialStore: store
      });

      const result = await auth.resolveCredential();
      expect(result.ok).toBe(true);
      expect(result.credential.accessToken).toBe('at-123');
      expect(result.credential.refreshToken).toBe('rt-123');
      // account_id comes from the token body (or the id_token claim).
      expect(result.credential.accountId).toBe('act-123');
      expect(result.credential.expiresAt).toBeGreaterThan(Date.now());
      // The refreshed credential was persisted.
      expect(store.load('codex')?.accessToken).toBe('at-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a revoked refresh token (400) clears the credential and surfaces auth_expired', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('codex', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        expiresAt: Date.now() - 1000
      });
      const auth = createCodexAuth({
        fetchImpl: async () => responseFrom(oauthTokenResponses.revoked),
        credentialStore: store
      });

      const result = await auth.resolveCredential();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('auth_expired');
      // Terminal refresh failure clears the stored credential.
      expect(store.load('codex')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a credential with plenty of time left is returned without a network call', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('codex', {
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh',
        idToken: 'fresh-id',
        expiresAt: Date.now() + 3_600_000
      });
      let calls = 0;
      const auth = createCodexAuth({
        fetchImpl: async () => {
          calls += 1;
          return responseFrom(oauthTokenResponses.success);
        },
        credentialStore: store
      });

      const result = await auth.resolveCredential();
      expect(result.ok).toBe(true);
      expect(result.credential.accessToken).toBe('fresh-access');
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
