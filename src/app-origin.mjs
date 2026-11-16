/**
 * The web app's origins the shell trusts. Around the host switch
 * (docs/HOST_SWITCH_PLAN.md) both production hosts serve the app — the root
 * domain and app., which redirects to it — so a window that follows a link
 * or a redirect from one to the other stays the app, with its IPC bridge,
 * instead of opening in the system browser. Mirrors `PRODUCTION_ORIGINS` in
 * `src/lib/site-origin.ts`.
 */
export const PRODUCTION_ORIGINS = [
  'https://tracinginsights.com',
  'https://app.tracinginsights.com'
];

/**
 * Origins trusted for `appUrl`: both production hosts when it is one of
 * them, otherwise just its own (a dev server via TIF1AI_APP_URL).
 * @param {string} appUrl
 * @returns {string[]}
 */
export function appOriginsFor(appUrl) {
  const origin = new URL(appUrl).origin;
  return PRODUCTION_ORIGINS.includes(origin)
    ? [...PRODUCTION_ORIGINS]
    : [origin];
}

/**
 * Whether `origin` is the app: `appOrigin` is one origin or the list from
 * `appOriginsFor`.
 * @param {string} origin
 * @param {string | readonly string[]} appOrigin
 */
export function isAppOrigin(origin, appOrigin) {
  return Array.isArray(appOrigin)
    ? appOrigin.includes(origin)
    : origin === appOrigin;
}
