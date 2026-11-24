/**
 * Build (and optionally publish) the Linux packages of one arch.
 *
 * electron-builder builds every Linux target of one invocation in parallel
 * from ONE shared linux-unpacked/ folder, and each .deb / .rpm writes its
 * `resources/package-type` marker (which makes electron-updater pick
 * DebUpdater / RpmUpdater) into that shared folder while the others may
 * still be packing it — a race (a local single-run build came out clean,
 * but nothing orders it). A marker in the wrong package would turn its
 * updates into a `dpkg -i` on Fedora or an AppImage that runs `dpkg`. So each group below is
 * its own invocation in its own output folder, and their latest-linux*.yml
 * files are merged into one before anything is uploaded:
 *
 *   AppImage + tar.gz  → no marker (AppImage updates itself; tar.gz never)
 *   deb                → package-type "deb"
 *   rpm                → package-type "rpm"
 *
 *   bun run scripts/linux-release.mjs --arch x64              # build into release/linux/
 *   bun run scripts/linux-release.mjs --arch arm64 --publish  # + upload to the GitHub release
 *   --skip rpm   leave a group out (local runs without rpmbuild)
 *
 * The x64 packages keep the plain TracingInsights-linux.<ext> names; other
 * arches are TracingInsights-linux-<arch>.<ext> (electron-updater reads
 * latest-linux-<arch>.yml there).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const DESKTOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** electron-builder.yml → publish (owner/repo). */
const RELEASE_REPO = 'TracingInsights/desktop';

/** Package groups, each built by its own electron-builder run. */
export const GROUPS = [
  { name: 'portable', targets: ['AppImage', 'tar.gz'], packageType: null },
  { name: 'deb', targets: ['deb'], packageType: 'deb' },
  { name: 'rpm', targets: ['rpm'], packageType: 'rpm' }
];

/**
 * One update-info document from several builds of the same version: every
 * file listed, the legacy top-level `path` / `sha512` from the first (the
 * AppImage), the latest release date.
 * @param {Array<{ version: string, files: Array<{ url: string }>, path?: string, sha512?: string, releaseDate?: string }>} docs
 */
export function mergeUpdateInfo(docs) {
  if (docs.length === 0) throw new Error('no update info to merge');
  const [first] = docs;
  const files = [];
  const seen = new Set();
  let releaseDate = first.releaseDate;
  for (const doc of docs) {
    if (doc.version !== first.version) {
      throw new Error(`version mismatch: ${doc.version} vs ${first.version}`);
    }
    for (const file of doc.files ?? []) {
      if (seen.has(file.url)) throw new Error(`${file.url} listed twice`);
      seen.add(file.url);
      files.push(file);
    }
    if (doc.releaseDate && (!releaseDate || doc.releaseDate > releaseDate)) {
      releaseDate = doc.releaseDate;
    }
  }
  return {
    ...first,
    files,
    ...(releaseDate ? { releaseDate } : {})
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { cwd: DESKTOP_DIR, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with ${result.status ?? result.signal}`);
  }
}

function main(argv) {
  const arch = argValue(argv, '--arch') ?? 'x64';
  if (!/^(x64|arm64)$/.test(arch)) throw new Error(`bad --arch ${arch}`);
  const publish = argv.includes('--publish');
  const skip = new Set(
    argv.flatMap((arg, i) => (argv[i - 1] === '--skip' ? [arg] : []))
  );
  const out = join(DESKTOP_DIR, 'release', `linux-${arch}`);
  const suffix = arch === 'x64' ? '' : `-${arch}`;
  const updateFile = `latest-linux${suffix}.yml`;
  rmSync(out, { recursive: true, force: true });

  const artifacts = [];
  const docs = [];
  for (const group of GROUPS) {
    if (skip.has(group.name)) continue;
    const dir = join(out, group.name);
    run('bunx', [
      'electron-builder',
      '--linux',
      ...group.targets,
      `--${arch}`,
      '--publish',
      'never',
      `-c.directories.output=${dir}`,
      ...(suffix
        ? [`-c.linux.artifactName=\${productName}-linux${suffix}.\${ext}`]
        : [])
    ]);
    const unpacked = join(
      dir,
      arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`
    );
    const marker = join(unpacked, 'resources', 'package-type');
    const found = existsSync(marker)
      ? readFileSync(marker, 'utf8').trim()
      : null;
    if (found !== group.packageType) {
      throw new Error(
        `${group.name}: package-type is ${found ?? 'absent'}, expected ${group.packageType ?? 'absent'}`
      );
    }
    const info = yaml.load(readFileSync(join(dir, updateFile), 'utf8'));
    docs.push(info);
    for (const target of group.targets) {
      const name = `TracingInsights-linux${suffix}.${target}`;
      const path = join(dir, name);
      if (!existsSync(path)) throw new Error(`missing ${path}`);
      artifacts.push(path);
    }
  }

  const dist = join(out, 'dist');
  mkdirSync(dist, { recursive: true });
  const files = artifacts.map((path) => {
    const target = join(dist, basename(path));
    copyFileSync(path, target);
    return target;
  });
  const merged = join(dist, updateFile);
  writeFileSync(merged, yaml.dump(mergeUpdateInfo(docs), { lineWidth: -1 }));
  files.push(merged);
  console.log(`\n${updateFile}:\n${readFileSync(merged, 'utf8')}`);

  if (publish) {
    run('bunx', [
      'electron-builder',
      'publish',
      '--policy',
      'always',
      ...files.flatMap((file) => ['--files', file])
    ]);
    // `electron-builder publish` logs an upload error and still exits 0:
    // check the release really has every file.
    const { version } = JSON.parse(
      readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')
    );
    const listed = spawnSync(
      'gh',
      [
        'release',
        'view',
        `v${version}`,
        '--repo',
        RELEASE_REPO,
        '--json',
        'assets',
        '-q',
        '.assets[].name'
      ],
      { cwd: DESKTOP_DIR, encoding: 'utf8' }
    );
    if (listed.status !== 0)
      throw new Error(`gh release view: ${listed.stderr}`);
    const names = new Set(listed.stdout.split('\n').map((s) => s.trim()));
    const missing = files.map((f) => basename(f)).filter((n) => !names.has(n));
    if (missing.length)
      throw new Error(`not on the release: ${missing.join(', ')}`);
    console.log(
      `published to v${version}: ${files.map((f) => basename(f)).join(', ')}`
    );
  } else {
    console.log(`built (not published):\n  ${files.join('\n  ')}`);
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
