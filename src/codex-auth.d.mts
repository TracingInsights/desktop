/** Type declarations for desktop/src/codex-auth.mjs (Codex device-auth port). */

export const CODEX_ISSUER: string;
export const CODEX_CLIENT_ID: string;
export const CODEX_DEVICE_VERIFICATION_URL: string;
export const CODEX_RESPONSES_URL: string;

export function createCodexAuth(deps?: Record<string, unknown>): unknown;
