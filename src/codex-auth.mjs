/**
 * Codex device-auth + credential store (main process).
 *
 * Port of `src/lib/ai/codex/device-auth.ts` to Node + safeStorage. Keep this
 * in sync with that file — the device-auth logic exists twice by design
 * (website TS for the server-proxy path, `.mjs` here for the harness path).
 *
 * The authorization_code exchange and token refresh happen in the main
 * process; only status/masked signals return to the page. Credentials are
 * stored via a `createCredentialStore` (safeStorage).
 */
import { createCredentialStore } from './credential-store.mjs';
import { inferenceError } from './protocols/shared.mjs';

export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';

const DEVICE_AUTH_BASE = `${CODEX_ISSUER}/api/accounts/deviceauth`;
const OAUTH_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
const TOKEN_REFRESH_SKEW_MS = 60_000;

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
  const [, payload] = String(token ?? '').split('.');
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '='
    );
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    const authClaims = parsed['https://api.openai.com/auth'];
    return authClaims && typeof authClaims === 'object' ? authClaims : parsed;
  } catch {
    return {};
  }
}

function credentialFromTokens(tokens) {
  if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) {
    throw new Error('Codex token response did not include required tokens.');
  }
  const now = Date.now();
  const idClaims = jwtClaims(tokens.id_token);
  const accessClaims = jwtClaims(tokens.access_token);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    accountId:
      typeof tokens.account_id === 'string'
        ? tokens.account_id
        : typeof idClaims.chatgpt_account_id === 'string'
          ? idClaims.chatgpt_account_id
          : undefined,
    planType:
      typeof idClaims.chatgpt_plan_type === 'string'
        ? idClaims.chatgpt_plan_type
        : typeof accessClaims.chatgpt_plan_type === 'string'
          ? accessClaims.chatgpt_plan_type
          : undefined,
    isFedrampAccount:
      typeof idClaims.chatgpt_account_is_fedramp === 'boolean'
        ? idClaims.chatgpt_account_is_fedramp
        : undefined,
    expiresAt:
      typeof tokens.expires_in === 'number'
        ? now + tokens.expires_in * 1000
        : undefined,
    updatedAt: now
  };
}

function normalizeCredential(credential) {
  const idClaims = jwtClaims(credential.idToken);
  const accessClaims = jwtClaims(credential.accessToken);
  return {
    ...credential,
    accountId:
      credential.accountId ??
      (typeof idClaims.chatgpt_account_id === 'string'
        ? idClaims.chatgpt_account_id
        : undefined),
    planType:
      credential.planType ??
      (typeof idClaims.chatgpt_plan_type === 'string'
        ? idClaims.chatgpt_plan_type
        : typeof accessClaims.chatgpt_plan_type === 'string'
          ? accessClaims.chatgpt_plan_type
          : undefined),
    isFedrampAccount:
      credential.isFedrampAccount ??
      (typeof idClaims.chatgpt_account_is_fedramp === 'boolean'
        ? idClaims.chatgpt_account_is_fedramp
        : undefined)
  };
}

function maskedValue(credential) {
  return credential?.accountId
    ? `ChatGPT ${credential.accountId.slice(0, 6)}...`
    : 'ChatGPT Codex';
}

function shouldRefresh(credential) {
  return (
    typeof credential.expiresAt === 'number' &&
    credential.expiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS
  );
}

/**
 * Create the Codex auth controller. `deps` accepts `fetchImpl`,
 * `credentialStore`, and `now` for tests.
 */
export function createCodexAuth(deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    credentialStore = createCredentialStore(deps),
    now = () => Date.now()
  } = deps;

  // In-memory device-auth state for the in-progress connection.
  let pendingDevice = null;

  return {
    async status() {
      const credential = credentialStore.load('codex');
      return {
        connected: Boolean(credential),
        ...(credential?.accountId ? { accountId: credential.accountId } : {}),
        ...(credential ? { masked: maskedValue(credential) } : {}),
        unencrypted: credentialStore.storedUnencrypted('codex')
      };
    },

    async startDeviceAuth() {
      const response = await fetchImpl(`${DEVICE_AUTH_BASE}/usercode`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
      });
      if (!response.ok) {
        return inferenceError('http_error', {
          status: response.status,
          providerMessage: `Codex device-code request failed (HTTP ${response.status}).`
        });
      }
      const payload = await response.json();
      const userCode = payload.user_code ?? payload.usercode;
      const deviceAuthId = payload.device_auth_id ?? payload.device_code;
      if (!deviceAuthId || !userCode) {
        return inferenceError('invalid_request', {
          providerMessage: 'Codex device-code response was missing a user code.'
        });
      }
      pendingDevice = {
        deviceAuthId,
        userCode,
        intervalSeconds: parseInterval(payload.interval)
      };
      return {
        ok: true,
        deviceCode: userCode,
        verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        intervalSeconds: pendingDevice.intervalSeconds,
        expiresAt: undefined
      };
    },

    async pollDeviceAuth() {
      if (!pendingDevice) {
        return inferenceError('invalid_request', {
          providerMessage: 'No Codex device authorization in progress.'
        });
      }
      const response = await fetchImpl(`${DEVICE_AUTH_BASE}/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          device_auth_id: pendingDevice.deviceAuthId,
          user_code: pendingDevice.userCode
        })
      });
      const payload = await readJson(response);

      if (payload.status === 'pending') {
        return { ok: true, status: 'pending' };
      }
      if (payload.status === 'slow_down') {
        return { ok: true, status: 'slow_down' };
      }
      if (payload.status === 'denied') {
        pendingDevice = null;
        return {
          ok: true,
          status: 'denied',
          message: errorMessage(payload, 'Codex authorization was denied.')
        };
      }
      if (payload.status === 'expired') {
        pendingDevice = null;
        return {
          ok: true,
          status: 'expired',
          message: errorMessage(payload, 'Codex device code expired.')
        };
      }

      if (response.ok) {
        const authorizationCode =
          payload.authorization_code ?? payload.auth_code;
        if (!authorizationCode || !payload.code_verifier) {
          pendingDevice = null;
          return inferenceError('invalid_request', {
            providerMessage: 'Codex device auth succeeded without PKCE details.'
          });
        }
        const codeVerifier = payload.code_verifier;
        pendingDevice = null;
        const exchange = await this.connectFromAuthorization(
          authorizationCode,
          codeVerifier
        );
        if (!exchange.ok) return exchange;
        return {
          ok: true,
          status: 'authorized',
          accountId: exchange.accountId
        };
      }

      const code = errorCode(payload);
      if (response.status === 429 || code === 'slow_down') {
        return { ok: true, status: 'slow_down' };
      }
      if (
        response.status === 403 ||
        response.status === 404 ||
        code === 'authorization_pending'
      ) {
        return { ok: true, status: 'pending' };
      }
      if (code === 'access_denied' || code === 'denied') {
        pendingDevice = null;
        return {
          ok: true,
          status: 'denied',
          message: errorMessage(payload, 'Codex authorization was denied.')
        };
      }
      if (code === 'expired_token' || code === 'expired') {
        pendingDevice = null;
        return {
          ok: true,
          status: 'expired',
          message: errorMessage(payload, 'Codex device code expired.')
        };
      }

      pendingDevice = null;
      return inferenceError('http_error', {
        status: response.status,
        providerMessage: `Codex device auth failed (HTTP ${response.status}).`
      });
    },

    /** Exchange an authorization code for tokens and persist them. */
    async connectFromAuthorization(authorizationCode, codeVerifier) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: DEVICE_REDIRECT_URI,
        client_id: CODEX_CLIENT_ID,
        code_verifier: codeVerifier
      });
      const response = await fetchImpl(OAUTH_TOKEN_URL, {
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
          providerMessage: `Codex token exchange failed (HTTP ${response.status}).`
        });
      }
      const credential = credentialFromTokens(await response.json());
      credentialStore.save('codex', credential);
      return { ok: true, accountId: credential.accountId };
    },

    /**
     * `codex.connect(token)` — persist a caller-supplied credential object
     * (used by legacy credential migration; see §8/OQ1).
     */
    async connect(credential) {
      if (!credential?.accessToken || !credential?.refreshToken) {
        return inferenceError('invalid_request', {
          providerMessage: 'Invalid Codex credential.'
        });
      }
      credentialStore.save('codex', normalizeCredential(credential));
      return { ok: true, accountId: credential.accountId };
    },

    async disconnect() {
      pendingDevice = null;
      credentialStore.delete('codex');
    },

    /**
     * Load the credential, refreshing lazily when `expiresAt <= now + skew`.
     * Terminal refresh failures (400/401) clear the stored credential and
     * surface `auth_expired`.
     */
    async resolveCredential() {
      let credential = credentialStore.load('codex');
      if (!credential) {
        return inferenceError('auth_expired', {
          providerMessage: 'Codex is not connected.'
        });
      }
      credential = normalizeCredential(credential);
      if (shouldRefresh(credential)) {
        const body = new URLSearchParams({
          client_id: CODEX_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken
        });
        const response = await fetchImpl(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json'
          },
          body
        });
        if (!response.ok) {
          if (response.status === 400 || response.status === 401) {
            credentialStore.delete('codex');
            return inferenceError('auth_expired', {
              providerMessage: 'Codex authorization expired. Reconnect.'
            });
          }
          return inferenceError('http_error', {
            status: response.status,
            providerMessage: `Codex token refresh failed (HTTP ${response.status}).`
          });
        }
        const payload = await response.json();
        credential = {
          ...credential,
          ...credentialFromTokens({
            access_token: payload.access_token ?? credential.accessToken,
            refresh_token: payload.refresh_token ?? credential.refreshToken,
            id_token: payload.id_token ?? credential.idToken,
            account_id: payload.account_id,
            expires_in: payload.expires_in
          }),
          updatedAt: now()
        };
        credentialStore.save('codex', credential);
      }
      return { ok: true, credential };
    }
  };
}
