/**
 * xAI device-auth + credential store (main process).
 *
 * Port of `src/lib/ai/xai/device-auth.ts` to Node + safeStorage. Keep this in
 * sync with that file — the device-auth logic exists twice by design (website
 * TS for the server-proxy path, `.mjs` here for the harness path).
 *
 * Standard OAuth device-code flow against auth.x.ai; the `authorized`
 * credential is kept in the main process (never returned to the page).
 */
import { createCredentialStore } from './credential-store.mjs';
import { inferenceError } from './protocols/shared.mjs';

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';
export const XAI_OAUTH_RESPONSES_URL =
  'https://cli-chat-proxy.grok.com/v1/responses';

const DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
const TOKEN_REFRESH_SKEW_MS = 120_000;

function parseInterval(value, fallback = 5) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorCode(payload) {
  if (typeof payload.error === 'string') return payload.error;
  return payload.error?.code ?? '';
}

function errorMessage(payload, fallback) {
  if (payload.error_description) return payload.error_description;
  if (typeof payload.error !== 'string' && payload.error?.message) {
    return payload.error.message;
  }
  return fallback;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function jwtClaims(token) {
  if (!token) return {};
  const [, payload] = token.split('.');
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '='
    );
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function credentialFromTokens(tokens, previousRefreshToken) {
  if (!tokens.access_token) {
    throw new Error('xAI token response did not include an access token.');
  }
  const refreshToken = tokens.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    throw new Error('xAI token response did not include a refresh token.');
  }
  const now = Date.now();
  const claims = jwtClaims(tokens.access_token);
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  return {
    accessToken: tokens.access_token,
    refreshToken,
    idToken: tokens.id_token,
    tokenType: tokens.token_type ?? 'Bearer',
    expiresAt:
      typeof tokens.expires_in === 'number'
        ? now + tokens.expires_in * 1000
        : exp,
    updatedAt: now
  };
}

function shouldRefresh(credential) {
  return (
    typeof credential.expiresAt === 'number' &&
    credential.expiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS
  );
}

export function createXaiAuth(deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    credentialStore = createCredentialStore(deps),
    now = () => Date.now()
  } = deps;

  let pendingDevice = null;

  return {
    async status() {
      const credential = credentialStore.load('xai-oauth');
      return {
        connected: Boolean(credential),
        ...(credential ? { masked: 'xAI Grok OAuth' } : {}),
        unencrypted: credentialStore.storedUnencrypted('xai-oauth')
      };
    },

    async startDeviceAuth() {
      const body = new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE
      });
      const response = await fetchImpl(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json'
        },
        body
      });
      if (!response.ok) {
        return inferenceError('http_error', {
          status: response.status,
          providerMessage: `xAI device-code request failed (HTTP ${response.status}).`
        });
      }
      const payload = await response.json();
      if (!payload.device_code || !payload.user_code) {
        return inferenceError('invalid_request', {
          providerMessage: 'xAI device-code response was missing a user code.'
        });
      }
      const intervalSeconds = parseInterval(payload.interval);
      const expiresIn = parseInterval(payload.expires_in, 0);
      pendingDevice = { deviceCode: payload.device_code, intervalSeconds };
      return {
        ok: true,
        deviceCode: payload.user_code,
        verificationUrl:
          payload.verification_uri_complete ??
          payload.verification_uri ??
          payload.verification_url ??
          `https://accounts.x.ai/oauth2/device?user_code=${encodeURIComponent(payload.user_code)}`,
        intervalSeconds,
        expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined
      };
    },

    async pollDeviceAuth() {
      if (!pendingDevice) {
        return inferenceError('invalid_request', {
          providerMessage: 'No xAI device authorization in progress.'
        });
      }
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: pendingDevice.deviceCode
      });
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json'
        },
        body
      });
      const payload = await readJson(response);
      if (response.ok) {
        const credential = credentialFromTokens(payload);
        credentialStore.save('xai-oauth', credential);
        pendingDevice = null;
        return { ok: true, status: 'authorized' };
      }

      const code = errorCode(payload);
      if (code === 'authorization_pending') {
        return { ok: true, status: 'pending' };
      }
      if (response.status === 429 || code === 'slow_down') {
        return { ok: true, status: 'slow_down' };
      }
      if (code === 'access_denied' || code === 'denied') {
        pendingDevice = null;
        return {
          ok: true,
          status: 'denied',
          message: errorMessage(payload, 'xAI authorization was denied.')
        };
      }
      if (code === 'expired_token' || code === 'expired') {
        pendingDevice = null;
        return {
          ok: true,
          status: 'expired',
          message: errorMessage(payload, 'xAI device code expired.')
        };
      }

      pendingDevice = null;
      return inferenceError('http_error', {
        status: response.status,
        providerMessage: `xAI device auth failed (HTTP ${response.status}).`
      });
    },

    /**
     * `xai.connect(credential)` — persist a caller-supplied credential object
     * (used by legacy credential migration; see docs/custom-providers-desktop.md
     * §8/OQ1). Mirrors `codex.connect`.
     */
    async connect(credential) {
      if (!credential?.accessToken || !credential?.refreshToken) {
        return inferenceError('invalid_request', {
          providerMessage: 'Invalid xAI credential.'
        });
      }
      credentialStore.save('xai-oauth', {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        idToken: credential.idToken,
        tokenType: credential.tokenType ?? 'Bearer',
        expiresAt: credential.expiresAt,
        updatedAt: credential.updatedAt ?? Date.now()
      });
      return { ok: true };
    },

    async disconnect() {
      pendingDevice = null;
      credentialStore.delete('xai-oauth');
    },

    async resolveCredential() {
      let credential = credentialStore.load('xai-oauth');
      if (!credential) {
        return inferenceError('auth_expired', {
          providerMessage: 'xAI is not connected.'
        });
      }
      if (shouldRefresh(credential)) {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: XAI_OAUTH_CLIENT_ID,
          refresh_token: credential.refreshToken
        });
        const response = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json'
          },
          body
        });
        if (!response.ok) {
          if (response.status === 400 || response.status === 401) {
            credentialStore.delete('xai-oauth');
            return inferenceError('auth_expired', {
              providerMessage: 'xAI authorization expired. Reconnect.'
            });
          }
          return inferenceError('http_error', {
            status: response.status,
            providerMessage: `xAI token refresh failed (HTTP ${response.status}).`
          });
        }
        credential = credentialFromTokens(
          await response.json(),
          credential.refreshToken
        );
        credential.updatedAt = now();
        credentialStore.save('xai-oauth', credential);
      }
      return { ok: true, credential };
    }
  };
}
