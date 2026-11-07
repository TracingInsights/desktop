/** Type declarations for desktop/src/xai-auth.mjs (xAI device-auth port). */

export const XAI_OAUTH_ISSUER: string;
export const XAI_OAUTH_CLIENT_ID: string;
export const XAI_OAUTH_SCOPE: string;
export const XAI_OAUTH_RESPONSES_URL: string;

export function createXaiAuth(deps?: Record<string, unknown>): unknown;
