/**
 * Desktop pets — sprite paths for the hand-off timeline
 * (docs/DESKTOP_PETS_NATIVE_PLAN.md §4.2).
 *
 * The native pet accepts timeline sprites only inside userData (ti-pet's
 * `timeline.zig` `pathInside`). Pets from our own store already live there;
 * a pet from the Codex folder (`~/.codex/pets`, read-only to us) does not, so
 * its sheet is copied into `userData/pet-sprites/` (0600) and the timeline
 * points at the copy. The copy is refreshed whenever the source's size or
 * mtime changes. Live `render` messages keep the original path.
 */
import { createHash } from 'node:crypto';
import { extname, isAbsolute, join, relative } from 'node:path';

export const TIMELINE_SPRITES_DIR = 'pet-sprites';

/** True when `path` is strictly inside `dir` (no `..`, not `dir` itself). */
export function isInsideDir(dir, path) {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * @param {{
 *   userDataDir: string,
 *   fs: Pick<typeof import('node:fs'), 'statSync'|'mkdirSync'|'copyFileSync'|'chmodSync'|'utimesSync'|'renameSync'|'rmSync'>,
 *   resolveSourcePath: (spriteUrl: string) => string|null
 * }} deps
 * @returns {(spriteUrl: string) => string|null}
 */
export function createTimelineSpriteResolver({
  userDataDir,
  fs,
  resolveSourcePath
}) {
  return (spriteUrl) => {
    const source = resolveSourcePath(spriteUrl);
    if (!source) return null;
    if (isInsideDir(userDataDir, source)) return source;
    try {
      const from = fs.statSync(source);
      const dir = join(userDataDir, TIMELINE_SPRITES_DIR);
      const name = createHash('sha256').update(source).digest('hex');
      const dest = join(dir, `${name.slice(0, 16)}${extname(source)}`);
      try {
        const to = fs.statSync(dest);
        // utimes keeps the copy's mtime only to the millisecond or so.
        if (to.size === from.size && Math.abs(to.mtimeMs - from.mtimeMs) < 1) {
          return dest;
        }
      } catch {
        // No copy yet.
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${dest}.${process.pid}.tmp`;
      try {
        fs.copyFileSync(source, tmp);
        fs.chmodSync(tmp, 0o600);
        fs.utimesSync(tmp, from.atime, from.mtime);
        fs.renameSync(tmp, dest);
      } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
      }
      return dest;
    } catch (error) {
      console.warn('[pets] timeline sprite copy:', error);
      return null;
    }
  };
}
