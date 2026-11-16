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

  test('parallel calls share one refresh (the token rotates once)', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('codex', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        expiresAt: Date.now() - 1000
      });
      let calls = 0;
      const auth = createCodexAuth({
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
      expect(store.load('codex')?.refreshToken).toBe('rt-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a refresh rejected after a reconnect keeps the new credential', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      store.save('codex', {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1000
      });
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const auth = createCodexAuth({
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
      expect(store.load('codex')?.refreshToken).toBe('new-refresh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('codex device auth (flow lifetime)', () => {
  const USERCODE_URL =
    'https://auth.openai.com/api/accounts/deviceauth/usercode';
  const POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';

  /** Device endpoints; `gates` hold back the poll / exchange responses. */
  function deviceFetch({ poll, exchange = oauthTokenResponses.success }) {
    let starts = 0;
    const gates = { poll: null, exchange: null };
    const fetchImpl = async (url) => {
      if (url === USERCODE_URL) {
        starts += 1;
        return new Response(
          JSON.stringify({
            user_code: `CODE-${starts}`,
            device_auth_id: `device-${starts}`,
            interval: 5
          }),
          { status: 200 }
        );
      }
      if (url === POLL_URL) {
        await gates.poll;
        return poll();
      }
      await gates.exchange;
      return responseFrom(exchange);
    };
    return { fetchImpl, gates };
  }

  test('disconnect during the code exchange: nothing is saved', async () => {
    const { dir, store } = makeCredentialStore();
    try {
      const { fetchImpl, gates } = deviceFetch({
        poll: () =>
          new Response(
            JSON.stringify({ authorization_code: 'ac', code_verifier: 'cv' }),
            { status: 200 }
          )
      });
      let release;
      gates.exchange = new Promise((resolve) => (release = resolve));
      const auth = createCodexAuth({ fetchImpl, credentialStore: store });
      expect((await auth.startDeviceAuth()).ok).toBe(true);
      const polled = auth.pollDeviceAuth();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await auth.disconnect();
      release();
      const result = await polled;
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('aborted');
      expect(store.load('codex')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale poll's answer does not end a newer flow", async () => {
    const { dir, store } = makeCredentialStore();
    try {
      let answer = 'denied';
      const { fetchImpl, gates } = deviceFetch({
        poll: () =>
          new Response(JSON.stringify({ status: answer }), { status: 200 })
      });
      let release;
      gates.poll = new Promise((resolve) => (release = resolve));
      const auth = createCodexAuth({ fetchImpl, credentialStore: store });
      await auth.startDeviceAuth();
      const stale = auth.pollDeviceAuth();
      expect((await auth.startDeviceAuth()).deviceCode).toBe('CODE-2');
      release();
      expect(await stale).toMatchObject({ ok: true, status: 'expired' });
      answer = 'pending';
      expect(await auth.pollDeviceAuth()).toEqual({
        ok: true,
        status: 'pending'
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
