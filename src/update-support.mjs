/**
 * Can this copy of the app update itself through electron-updater?
 *
 * Every installer the release workflow builds reads the same GitHub release,
 * but only some of them can install an update in place:
 *
 * - Windows NSIS installer: yes. The portable exe (`PORTABLE_EXECUTABLE_DIR`
 *   set by electron-builder's portable launcher) would have NsisUpdater run
 *   an installer over a copy that was never installed: no.
 * - macOS: yes (electron-updater needs a signed app; an unsigned one reports
 *   the error, as before).
 * - Linux AppImage (`APPIMAGE`) and the .deb / .rpm packages (electron-builder
 *   writes `resources/package-type`, which picks DebUpdater / RpmUpdater): yes.
 *   The .tar.gz and the Flatpak (`FLATPAK_ID`, read-only /app): no — they
 *   get "Download the latest version…" instead.
 *
 * @param {{
 *   isPackaged: boolean,
 *   platform: string,
 *   env: Record<string, string | undefined>,
 *   resourcesPath: string | undefined,
 *   exists: (path: string) => boolean
 * }} input
 * @returns {boolean}
 */
export function selfUpdateSupport({
  isPackaged,
  platform,
  env,
  resourcesPath,
  exists
}) {
  if (!isPackaged) return false;
  if (platform === 'win32') return !env.PORTABLE_EXECUTABLE_DIR;
  if (platform !== 'linux') return true;
  if (env.FLATPAK_ID) return false;
  if (env.APPIMAGE) return true;
  return Boolean(resourcesPath) && exists(`${resourcesPath}/package-type`);
}
