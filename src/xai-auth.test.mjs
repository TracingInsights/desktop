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

  test('parallel calls share one refresh (the token rotates once)', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('xai-oauth', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1000
      });
      let calls = 0;
      const auth = createXaiAuth({
        fetchImpl: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return calls === 1
            ? responseFrom(oauthTokenResponses.success)
            : responseFrom(oauthTokenResponses.revoked);
        },
        credentialStore: store
      });
      const results = await Promise.all([
        auth.resolveCredential(),
        auth.resolveCredential()
      ]);
      expect(calls).toBe(1);
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      expect(store.load('xai-oauth')?.refreshToken).toBe('rt-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a refresh rejected after a reconnect keeps the new credential', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('xai-oauth', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1000
      });
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const auth = createXaiAuth({
        fetchImpl: async () => {
          await gate;
          return responseFrom(oauthTokenResponses.revoked);
        },
        credentialStore: store
      });
      const pending = auth.resolveCredential();
      await auth.connect({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 3_600_000
      });
      release();
      expect((await pending).error.code).toBe('auth_expired');
      expect(store.load('xai-oauth')?.refreshToken).toBe('new-refresh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('xai device auth (flow lifetime)', () => {
  /** Device endpoints; `gates.token` holds back the token responses. */
  function deviceFetch(token) {
    let starts = 0;
    const gates = { token: null };
    const fetchImpl = async (url) => {
      if (url.endsWith('/oauth2/device/code')) {
        starts += 1;
        return new Response(
          JSON.stringify({
            device_code: `device-${starts}`,
            user_code: `CODE-${starts}`,
            interval: 5,
            expires_in: 1800
          }),
          { status: 200 }
        );
      }
      await gates.token;
      return token();
    };
    return { fetchImpl, gates };
  }

  test('disconnect while a poll is out: its tokens are not saved', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      const { fetchImpl, gates } = deviceFetch(() =>
        responseFrom(oauthTokenResponses.success)
      );
      let release;
      gates.token = new Promise((resolve) => (release = resolve));
      const auth = createXaiAuth({ fetchImpl, credentialStore: store });
      expect((await auth.startDeviceAuth()).ok).toBe(true);
      const polled = auth.pollDeviceAuth();
      await auth.disconnect();
      release();
      expect(await polled).toMatchObject({ ok: true, status: 'expired' });
      expect(store.load('xai-oauth')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale poll's answer does not end a newer flow", async () => {
    const { dir, store } = makeCredentialStore();
    try {
      let code = 'access_denied';
      const { fetchImpl, gates } = deviceFetch(
        () => new Response(JSON.stringify({ error: code }), { status: 400 })
      );
      let release;
      gates.token = new Promise((resolve) => (release = resolve));
      const auth = createXaiAuth({ fetchImpl, credentialStore: store });
      await auth.startDeviceAuth();
      const stale = auth.pollDeviceAuth();
      expect((await auth.startDeviceAuth()).deviceCode).toBe('CODE-2');
      release();
      expect(await stale).toMatchObject({ ok: true, status: 'expired' });
      code = 'authorization_pending';
      expect(await auth.pollDeviceAuth()).toEqual({
        ok: true,
        status: 'pending'
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
