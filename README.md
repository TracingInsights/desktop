# TracingInsights Desktop (Electron)

A desktop app that loads the TracingInsights web app and acts as the
**inference harness** for AI provider calls. It owns custom-provider
credentials, the Codex / Grok (xAI) device-auth tokens, the HTTP protocol
layer, and streaming — all in the Electron **main process** — so those calls
run through the user's own machine instead of the TracingInsights server.

## Why this exists

Browsers cannot call `chatgpt.com`, `auth.x.ai`, or
`cli-chat-proxy.grok.com` directly (no CORS headers), so in a regular browser
those calls are relayed through the TracingInsights server (`/api/codex/*`,
`/api/xai/*`). An Electron main process has no CORS restrictions and can also
reach the user's own local or hosted OpenAI-compatible endpoints — so the app
runs the protocol layer itself. Your ChatGPT and 𝕏 tokens stay on your
machine; the TracingInsights server never sees them.

It also lets desktop users bring **custom providers**: a local model (Ollama /
LM Studio / vLLM / llama.cpp on `127.0.0.1`) or a hosted OpenAI-compatible
endpoint (Fireworks, Together, DeepInfra, …), speaking one of three wire
protocols (`openai-completions`, `openai-responses`, `anthropic-messages`).

## How it works

```
┌────────────────────────────── Electron ────────────────────────────────┐
│ BrowserWindow ── loads https://app.tracinginsights.com ──┐            │
│                                                          │            │
│   window.tif1aiDesktop (preload, contextIsolation+sandbox)│            │
│     ipcRenderer.invoke('providers:*' | 'codex:*' |        │            │
│                       'xai:*' | 'inference:*')            │            │
│                                                          ▼            │
│   Electron main process (src/main.mjs + modules)                      │
│     ├─ Custom provider registry (JSON file, keys via safeStorage)     │
│     ├─ Codex device-auth + credential store (safeStorage)             │
│     ├─ xAI  device-auth + credential store (safeStorage)              │
│     ├─ Protocol adapters: completions / responses / anthropic         │
│     ├─ Codex + xAI inference adapters (native Node fetch — no CORS)   │
│     └─ Streaming relay → webContents.send('inference:chunk', …)       │
└────────────────────────────────────────────────────────────────────────┘
```

- The **preload** (`src/preload.cjs`) exposes a narrow, typed
  `window.tif1aiDesktop` surface; there is no generic `invoke` passthrough.
  The web app detects the shell (`isDesktopShell()`) and drives Codex / xAI /
  custom providers over IPC; Google / OpenRouter / Copilot keep
  the renderer → server-proxy path.
- **Credentials** live in the main process, stored with Electron
  `safeStorage` (Keychain / Credential Manager / kwallet). Keys are
  **write-only** over IPC — the page only ever sees `hasKey` / `masked`
  signals, never the key value.
- **Streaming** uses chunked `webContents.send('inference:chunk', …)` events
  keyed by a caller-supplied `requestId`; `inference.abort(requestId)`
  cancels either a stream or an in-flight `generate`. On page navigation /
  window destruction the harness aborts every in-flight request so a
  page-side promise can never hang.
- On macOS the app (and harness) stays alive in the dock after closing the
  window; on Windows/Linux closing the window quits and tears the harness
  down — unless close-to-tray is on (see "Desktop pets & tray" below).

## IPC surface (summary)

See `docs/custom-providers-desktop.md` §7.2 for the full contract.

- `providers.list / add / update / remove / test / listModels`
- `codex.status / startDeviceAuth / pollDeviceAuth / connect / disconnect / listModels`
- `xai.startDeviceAuth / pollDeviceAuth / status / disconnect / listModels`
- `inference.generate / stream / abort`
- `onStreamChunk(cb)` / `onStreamEnd(cb)` → `{ requestId, delta }` /
  `{ requestId, text, usage?, finishReason?, error? }`

Fallible methods resolve a discriminated `{ ok: true, … } | { ok: false,
error }` envelope rather than rejecting, because `ipcRenderer.invoke`
rejections drop custom error fields.

## Security model

| Threat                               | Mitigation                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untrusted page calls IPC             | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; every `ipcMain.handle` rejects senders that aren't the app-origin document in the main window (`isTrustedAppSender` in `src/ipc.mjs`).                                                                                                                                                                                         |
| SSRF via a compromised page          | Inference sends only `providerId` / `model` / `messages` — never a raw URL. Targets come from the user's own registry; loopback hosts over `http`, remote hosts over `https` only (`src/protocols/shared.mjs` `isAllowedTarget`). The one raw-URL primitive, `providers.listModels`, is a page-supplied `GET` (discover-before-save) and uses only a page-supplied key — never a stored credential. |
| Redirect bypass of target validation | All adapters issue `redirect: 'manual'` and re-validate every `Location` against the loopback/`https` rule before following it (native `fetch` would otherwise follow a `https → http://169.254.169.254` hop).                                                                                                                                                                                      |
| XSS-to-persistence escalation        | Registry writes that reroute traffic (add, or update where `baseUrl`/`protocol` change) are confirmed with a native `dialog.showMessageBox` naming the target `baseUrl`; metadata-only edits apply silently. The Settings list always shows each entry's id, label, and `baseUrl`.                                                                                                                  |
| Credential exfiltration              | Keys are write-only over IPC; stored via `safeStorage`; the page never reads them back. On Linux without a keyring (`safeStorage` unavailable / `basic_text`), keys fall back to a mode-`0600` plaintext file and the Settings UI surfaces a "keys stored unencrypted" warning — the harness never silently refuses to save.                                                                        |
| Streaming abuse / leaks              | Requests are scoped by `requestId`, coalesced into ~30–60 ms batches, and aborted on page navigation / window destruction. Generous connect/first-token + idle-chunk timeouts cap a stalled-but-open stream.                                                                                                                                                                                        |

## Desktop pets & tray

Codex-style animated pets float on the desktop in their own transparent,
always-on-top window (`src/pets/`, bundled page `src/pet/`). As-built doc:
`docs/DESKTOP_PETS.md`; design and owner decisions:
`docs/DESKTOP_PETS_PLAN.md`.

- **No pet art ships with the app.** Users pick pets in the website gallery
  at `/settings/pets` (shown in the main window; menu "Pets…", tray "Choose
  pet…") or import a downloaded `.zip` / folder. Pets live in
  `userData/pets/`; Codex pets in `~/.codex/pets` (or `$CODEX_HOME/pets`)
  are listed read-only. Tests use generated atlases only.
- **Only the main process talks to Petdex** (`petdex.dev` /
  `assets.petdex.dev`, allowlisted), and only while the gallery asks. Every
  pet — Petdex, Codex folder or import — passes `src/pets/pet-validate.mjs`
  first. The pet window loads only bundled files and `pet-asset://` sprites.
- **Reactions**: chat activity from the page (`pets.signal`), the F1
  calendar from `https://app.tracinginsights.com/desktop/schedule.json`
  (fetched on launch and every 24 h, cached in `userData`) as speech bubbles
  only — never OS notifications. "During sessions" = Calm (default) /
  Lively / Off; Quiet for 1 h or until the session ends from the pet's
  right-click menu or the tray.
- **Tray**: closing the window destroys it and the app keeps running in the
  tray (setting "Closing the window quits the app" opts out); reopen from
  the tray, by double-clicking the pet or by launching the app again.
  Launch at login is opt-in.
- **Linux**: with pets on in a Wayland session, the app relaunches itself
  once with `--ozone-platform=x11` in argv (XWayland) so the pet can stay on
  top and position itself — `app.commandLine.appendSwitch` is too late in
  Electron 38+ (no windows are drawn). Without XWayland (`DISPLAY` unset)
  there is no floating pet. The tray needs a
  StatusNotifier host (GNOME: the AppIndicator extension).
- **Native pet** (`docs/DESKTOP_PETS_NATIVE_PLAN.md`): when the installer
  carries `resources/ti-pet/ti-pet-<platform>-<arch>` (built by the
  `TracingInsights/petdex` fork, pinned in `native-pet.json`), that small
  program draws the pet and owns the tray. Closing the window compiles the
  next 7 days into `userData/pet-timeline.json`, hands it over on
  `userData/pet.sock` (token in `userData/pet-token`, both 0600) and **quits
  Electron**; the pet starts the app again with `--pets-open=<path>`,
  `--pets-refresh` (windowless recompile, < 1 s measured) or
  `--pets-install-update`. Quit from either side quits both. No binary, or
  one that cannot start → the Electron pet window above (`pets.status()`
  `renderer` / `rendererReason`; a failed start is remembered in
  `userData/pet-native-failure.json` so the next start relaunches under
  XWayland and the fallback pet can show). Dev:
  `TIF1AI_NATIVE_PET=<path to a ti-pet build or a wrapper>`,
  `TIF1AI_PETS_RENDERER=electron` forces the fallback; the protocol stub
  `src/pets/test-fixtures/native-pet-stub.mjs` stands in for the binary in
  tests.
- Settings: `userData/pets-settings.json` (pets off until a pet is picked).
  Tests: `bun test src/pets/`.

## Development

```bash
cd desktop
bun install            # downloads the Electron binary
bun run start          # launches against https://app.tracinginsights.com

# point at a local dev server instead:
TIF1AI_APP_URL=http://127.0.0.1:5173 bun run start
```

Timeout tuning (Ollama cold model loads can take minutes):

- `TIF1AI_MODEL_LOAD_GRACE_MS` — connect/first-token timeout (default 600 s).
- `TIF1AI_STREAM_IDLE_TIMEOUT_MS` — idle watchdog: no bytes since the last
  chunk (default 300 s).

### Tests

```bash
bun test                # unit tests for adapters, registry, IPC, inference
bun run smoke           # add → discover → stream → abort against a mock server
bun run e2e             # CDP e2e (requires the dev server on 5173 + Electron
                        # with --remote-debugging-port=9222)
```

Headless e2e: `xvfb-run -a bun run start -- --no-sandbox --disable-gpu
--remote-debugging-port=9222`.

The golden-trace fixtures in `src/protocols/__fixtures__/` are shared **data**
consumed by both the desktop `bun test` suite and the website's Vitest suite,
so SSE parsing and device-auth refresh logic are exercised against the same
recordings (shared data, not shared code — the SSE parsers are necessarily
duplicated between the TS website and the `.mjs` main process).

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

**Native pet.** `bun run scripts/fetch-native-pet.mjs --write` downloads the
`ti-pet` binaries pinned in `native-pet.json` and verifies their SHA-256
into `resources/ti-pet/` (`--target darwin` = both macOS arches, `--from
<dir>` = local files, `--require` = fail while unpinned). The release
workflow runs it before electron-builder; with the pin unset the installer
ships without it (Electron pet). `resources/ti-pet/` also holds the committed
license texts (`THIRD-PARTY-NOTICES.md`, Petdex MIT, Native SDK Apache-2.0),
which `extraResources` always packs; the script refuses to write a binary
without them. A new renderer: tag `ti-pet-vX.Y.Z` on the fork
(`.github/workflows/ti-pet-release.yml` builds linux-x64, win32-x64,
darwin-arm64, darwin-x64 + `SHA256SUMS`, never marked latest) → copy tag and
hashes into `native-pet.json` → desktop release. The `.deb` depends on
`libgtk-4-1` + `webp-pixbuf-loader`.

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

The site's Settings links these for non-desktop visitors
(`DESKTOP_DOWNLOAD_LINKS` in `src/lib/ai/desktop-bridge.ts` — keep it in sync
with `artifactName`).

The app checks for updates ~10 s after launch, every 6 hours while it runs
(closing the window keeps it in the tray, so it can run for days) and via
_TracingInsights → Check for Updates…_. Updates download in the background
(0.2.0+); when one is ready a notification, the tray menu and the app menu
offer "Restart to update", and otherwise it installs on quit. Dev runs
(`bun run start`) never check — only packaged builds do.

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
- Harness client: `src/lib/ai/desktop-harness.ts` (typed IPC helpers +
  `isDesktopShell`); `src/lib/ai/desktop-bridge.ts` keeps only the download
  links + shell detection.
- Desktop branches in the run layer: `src/lib/ai/run/browser-adapter.ts`
  (plan / repair / answer), `src/lib/ai/run/clients/codex-client.ts`,
  `src/lib/ai/run/clients/xai-oauth-client.ts`.
- Settings UI: `src/lib/components/provider-settings/CustomProvidersPanel.svelte`
  - the desktop branches in `CodexAuthPanel.svelte` / `XaiAuthPanel.svelte`
    (rendered by `ProviderSettings.svelte`); the dropdown merge is in
    `ChatProviderBar.svelte`.
- Static model catalogs: `desktop/src/model-catalogs.mjs` is the shared source used by
  the harness and the site routes under
  `src/routes/api/{codex,xai}/models/+server.ts`.
- App icons: `assets/icon.png` (logo source) → generated `build/icon.*`.

## Known limitations

- **macOS auto-update requires a signed + notarized app.** Until Developer ID
  signing is configured, macOS users get new releases from the GitHub
  Releases page, not in-app updates.
- Codex/xAI credentials are stored in `safeStorage`; on Linux without a
  keyring they fall back to a mode-`0600` plaintext file (surfaced in the UI).
- Custom providers are gated to the desktop shell; a regular browser never
  sees them. Remote custom endpoints must be `https`; plain-`http` LAN hosts
  (e.g. Ollama on `http://192.168.x.x:11434`) are excluded by design — run
  them locally or front them with `https`.
- Closing the app window on Windows/Linux quits the harness (macOS keeps it
  alive in the dock).
