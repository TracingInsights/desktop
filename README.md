# TracingInsights Desktop (Electron)

A desktop app that loads the TracingInsights web app and runs a **localhost
bridge** so ChatGPT **Codex** and **Grok (𝕏 Premium+ / SuperGrok)** calls go
through the user's own machine instead of the TracingInsights server.

## Why this exists

Browsers cannot call `chatgpt.com`, `auth.x.ai`, or
`cli-chat-proxy.grok.com` directly (no CORS headers), so today those calls are
relayed through the TracingInsights server (`/api/codex/*`, `/api/xai/*`).
An Electron main process has no CORS restrictions — so this app runs a tiny
HTTP server on `127.0.0.1` that mirrors those exact routes. The web app
detects the bridge and rewrites Codex/Grok requests to it. Your ChatGPT and 𝕏
tokens stay on your machine; the TracingInsights server never sees them.

## How it works

```
┌────────────────────────── Electron ──────────────────────────┐
│ BrowserWindow  ── loads https://app.tracinginsights.com ──┐  │
│                                                           │  │
│   site fetch:  http://127.0.0.1:4318/api/codex/responses  │  │
│                          │  x-bridge-token: <pairing>     │  │
│                          ▼                                │  │
│   bridge.mjs (node:http, bound to 127.0.0.1)              │  │
│     ├─ /api/codex/responses  → chatgpt.com/backend-api/…  │  │
│     ├─ /api/xai/responses    → cli-chat-proxy.grok.com/…  │  │
│     ├─ /api/xai/oauth        → auth.x.ai (device code)    │  │
│     └─ /api/{codex,xai}/models → static catalogs          │  │
└──────────────────────────────────────────────────────────────┘
```

- The **preload** (`src/preload.cjs`) exposes `window.tif1aiDesktop`; the web
  app's _Settings → AI Provider → Desktop Bridge_ panel auto-fills and
  auto-connects when running inside the shell. The bridge is reachable only
  from inside the desktop app — the site's CSP grants loopback connections to
  desktop-app requests only (see the security section below), so there is no
  manual pairing from a regular browser.
- The **pairing token** is generated on first run, encrypted at rest with the
  OS keychain (`safeStorage`; plaintext fallback with a console warning on
  Linux without a keyring), and required on every bridge request except
  `/health`. It is not a cookie, so no other website can use your
  subscriptions.
- **Reset Bridge Token** (Bridge menu / Bridge Info window) rotates the token
  and restarts the bridge on the same port, then pushes the new state to both
  windows over `bridge:changed`. The web app swaps the fresh token into its
  encrypted config in place (`applyShellBridgeInfo`), so Codex/Grok calls keep
  working and the settings panel re-pairs to _Active_ without a manual
  disconnect + re-paste.
- On macOS the app (and bridge) stays alive in the dock after closing the
  window; on Windows/Linux closing the window quits and stops the bridge.

## Security model

| Threat                                             | Mitigation                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Random website uses your Codex/Grok via the bridge | Bridge binds `127.0.0.1` only; every route except `/health` requires the pairing token (`x-bridge-token`, timing-safe compare). Token is not a cookie and lives in the site's encrypted local storage only.                                                                                                                                           |
| DNS rebinding (`evil.com` → `127.0.0.1`)           | Bridge rejects any `Host` header that isn't a loopback hostname (403).                                                                                                                                                                                                                                                                                |
| Website fingerprinting the local bridge            | Accepted trade-off: any site can probe the enumerable port range (4318–4342) and see `/health` answer — presence and bound port are inherent to a localhost agent (the prober already knows the port it connected to). The bridge version is only revealed to callers presenting a valid pairing token, so probes cannot fingerprint the exact build. |
| Other local processes                              | Same pairing-token gate applies — only the web app with the stored token can call the bridge.                                                                                                                                                                                                                                                         |
| Token at rest                                      | `safeStorage` (Keychain / Credential Manager / kwallet).                                                                                                                                                                                                                                                                                              |
| Token exfiltration                                 | Never sent to the TracingInsights server; readable only by the app origin in the main window and the local Bridge Info window. OAuth provider pages and other third-party pages are denied token-bearing IPC.                                                                                                                                         |

## Development

```bash
cd desktop
bun install            # downloads the Electron binary
bun run start          # launches against https://app.tracinginsights.com

# point at a local dev server instead:
TIF1AI_APP_URL=http://127.0.0.1:5173 bun run start

# change the bridge port — must stay inside the CSP-allowlisted
# 4318–4342 range (the web app only grants loopback connections to these
# ports, so an out-of-range override would be unreachable):
TIF1AI_BRIDGE_PORT=4325 bun run start
```

`bun run start` prints `[bridge] listening on http://127.0.0.1:<port>`.

**End-to-end verification** (requires the dev server on 5173 and Electron
launched with `--remote-debugging-port=9222`):

```bash
bun run e2e   # from desktop/; drives the Electron window via CDP and checks
              # auto-connect, localhost routing, and live forwards
```

Headless environments: `xvfb-run -a bun run start -- --no-sandbox
--disable-gpu --remote-debugging-port=9222`.

Test the bridge without launching Electron:

```bash
bun -e "import { createBridgeServer, DEFAULT_PORT } from './src/bridge.mjs'; const s = createBridgeServer({ token: 'demo-token-1234567890' }); s.listen(DEFAULT_PORT, '127.0.0.1', () => console.log('up'));"
curl http://127.0.0.1:4318/health
curl -H 'x-bridge-token: demo-token-1234567890' http://127.0.0.1:4318/api/codex/models
```

## Packaging

```bash
cd desktop
bun run icons            # regenerate build/icon.{png,icns,ico} from assets/icon.png
bun run pack             # unpacked build in release/ (fast, for testing)
bun run dist:mac         # dmg + zip (requires macOS)
bun run dist:win         # nsis installer
bun run dist:linux       # AppImage + deb
bun run publish:release  # ship a release via the public mirror repo (see below)
```

**Icons.** `build/icon.png` (1024×1024), `build/icon.icns`, and
`build/icon.ico` are generated from `assets/icon.png` (the TracingInsights
logo — `#00ff00` green field, dark monogram) by
`scripts/generate-icons.mjs` (resvg-wasm → PNG, png2icons → ICNS/ICO — pure
JS, no native toolchain). The script self-checks the render (green
background, dark monogram pixels) and the output formats before writing the
files. Commit the generated `build/` files; electron-builder reads them via
the `mac.icon` / `win.icon` / `linux.icon` keys in `electron-builder.yml`.

## Releases & auto-update

The tif1ai repo is **private**, which blocks the usual GitHub flow twice
over: release assets on a private repo require a GitHub login to download,
and private-repo Actions minutes are limited (macOS runners burn them at
10×). Releases therefore ship through a small **public mirror repo** —
`TracingInsights/desktop` — which holds only this `desktop/`
directory (no web app code). GitHub Actions are free and unlimited on public
repos, the published installers download without a login, and shipped apps
auto-update from there (`publish` in `electron-builder.yml` points at the
public repo).

Ship a desktop update like this:

1. Bump `version` in `desktop/package.json` (electron-updater compares
   semver — it must be **higher** than the current release).
2. Commit + push, then from `desktop/`:

   ```bash
   bun run publish:release            # or: -- --dry-run to preview
   ```

   The script mirrors the desktop sources into a local checkout of the
   public repo (`desktop/.release-checkout/`, gitignored), installs
   `desktop/release-template/desktop-release.yml` as the public repo's
   `.github/workflows/desktop-release.yml`, commits, tags `vX.Y.Z`, and
   pushes. It refuses to re-use a tag that already exists remotely.

3. The tag push triggers the public repo's workflow, which builds **mac**
   (dmg + zip, universal), **win** (nsis) and **linux** (AppImage + deb) in
   parallel and publishes them — with electron-updater metadata
   (`latest*.yml`) — to the GitHub Release for that tag.

First time only, create the public repo (or let the script tell you):

```bash
gh repo create TracingInsights/desktop --public \
  --description "TracingInsights desktop app — installers and auto-update releases"
```

**Download links** (stable — artifact names carry no version, see
`artifactName` in `electron-builder.yml`):

- Releases page: `https://github.com/TracingInsights/desktop/releases/latest`
- `…/releases/latest/download/TracingInsights-mac.dmg`
- `…/releases/latest/download/TracingInsights-win.exe`
- `…/releases/latest/download/TracingInsights-linux.AppImage`

The site's Settings → AI Provider → Desktop Bridge panel links these for
non-desktop visitors (`DESKTOP_DOWNLOAD_LINKS` in
`src/lib/ai/desktop-bridge.ts` — keep it in sync with `artifactName`).

The app checks for updates ~10 s after launch and via _Bridge → Check for
Updates…_. Downloads are user-confirmed; once downloaded, the new version
installs on quit or immediately via "Restart Now". Dev runs (`bun run start`)
never check — only packaged builds do.

**Deploy order matters.** The site's CSP only grants loopback `connect-src`
to requests carrying the `x-tif1ai-desktop-shell` marker header (set by this
app's `webRequest` hook). The web deploy that tightened the CSP (removed the
old `http://127.0.0.1:*` wildcard) must land together with — or before — a
desktop release that sends the header (already the case in production).
Installed desktop apps that predate the header would be served the
restrictive CSP and lose bridge connectivity until they auto-update.

### Signing requirements

| Platform | Auto-update requires             | Without signing                                                                  |
| -------- | -------------------------------- | -------------------------------------------------------------------------------- |
| macOS    | Developer ID cert + notarization | Apps install with Gatekeeper warnings and **cannot** self-update on modern macOS |
| Windows  | Authenticode cert (optional)     | SmartScreen "unknown publisher" warning; auto-update still works                 |
| Linux    | none (AppImage)                  | Auto-update works for AppImage builds; `.deb` installs update via apt instead    |

Set `CSC_LINK` / `CSC_KEY_PASSWORD` (+ `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization) as
repository secrets **on the public `TracingInsights/desktop` repo** (that is where
the build workflow runs); absent secrets mean electron-builder skips
signing. The workflow always publishes, signed or not — unsigned builds
still get installers, but macOS users must download them manually. Windows
signing can be free for open-source projects via
[SignPath.io](https://signpath.io); macOS has no free path (Apple Developer
Program, $99/yr).

Publishing is protected from mid-flight cancellation
(`concurrency: cancel-in-progress: false`) and the workflow regenerates the
icons from `assets/icon.png` and fails if the committed `build/` icons have
drifted (same contract as the stats manifest checks).

## Repo integration points

- Release pipeline: `scripts/publish-release.mjs` mirrors `desktop/` to the
  public `TracingInsights/desktop` repo and tags `vX.Y.Z`; the
  workflow template `release-template/desktop-release.yml` becomes that
  repo's build-and-publish workflow. Download URLs for the site live in
  `src/lib/ai/desktop-bridge.ts` (`DESKTOP_DOWNLOAD_LINKS`).
- Web-side bridge client: `src/lib/ai/desktop-bridge.ts` (primitives:
  config, health, URL rewriting) and `src/lib/ai/bridge-sync.ts` (singleton
  shell-push sync + event bus for UI updates)
- Proxy URL consumers rewired through the bridge: `src/lib/ai/run/clients/codex-client.ts`,
  `src/lib/ai/run/clients/xai-oauth-client.ts`, `src/lib/ai/xai/device-auth.ts`,
  `src/lib/ai/providers/codex.client.ts`, `src/lib/ai/providers/xai-oauth.client.ts`
- Settings UI: `src/lib/components/provider-settings/DesktopBridgePanel.svelte`
  (rendered by `ProviderSettings.svelte`)
- CSP loopback allowance: `DESKTOP_BRIDGE_ORIGINS` in
  `src/lib/server/hooks/handlers/security-headers.ts` — enumerated 4318–4342
  ports, emitted only for requests carrying the desktop-shell marker header
  (`x-tif1ai-desktop-shell`, set by this app's `webRequest` hook); unit tests
  keep both sides in sync
- Static model catalogs: `desktop/src/model-catalogs.mjs` is the shared source used by
  both the bridge and the site routes under
  `src/routes/api/{codex,xai}/models/+server.ts`
- App icons: `assets/icon.png` (logo source) → generated `build/icon.*`

## Known limitations

- **macOS auto-update requires a signed + notarized app.** Until Developer ID
  signing is configured, macOS users get new releases from the GitHub
  Releases page, not in-app updates.
- The app stores the bridge pairing token, not your Codex/Grok credentials —
  those live in the site's encrypted local storage (IndexedDB) and are never
  touched by the desktop app or the server.
- Safari blocks mixed content (`https` page → `http://127.0.0.1`) — bridge
  auto-connect only works in Chromium/Firefox or inside this Electron app.
- The site's encrypted bridge config uses the same key-crypto scheme as API
  keys. In session-only mode the encryption seed lives only in memory, so
  when the tab closes the stored value becomes undecryptable rather than
  being physically cleared from localStorage.
- Closing the app window on Windows/Linux stops the bridge (macOS keeps it
  alive in the dock).
- The site's CSP only grants loopback `connect-src` to requests carrying the
  desktop-shell marker header, and only for the enumerated 4318–4342 ports
  (`DESKTOP_BRIDGE_ORIGINS` in `src/lib/server/hooks/handlers/security-headers.ts`).
  Regular browsers never receive loopback `connect-src`, so manual bridge
  pairing from a regular browser is not possible — the bridge is a
  desktop-app-only feature. Residual risk (bounded, not eliminated): inside
  the desktop app, an XSS could reach a local service bound to one of the
  4318–4342 ports. See the comment on `DESKTOP_BRIDGE_ORIGINS` for the full
  rationale.
