import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const noticeName = /^(?:licen[cs]es?|copying|notice|copyright|unlicense)(?:$|[._-])/i;
const archiveComponent = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const allocatorLicenseSha256 = 'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function resolvedExternalCrates(metadata) {
  const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
  return metadata.packages.filter(crate => crate.source && resolved.has(crate.id))
    .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
}

async function nativeNotices(crate) {
  const directory = path.dirname(crate.manifest_path);
  const files = await readdir(directory, { withFileTypes: true });
  return Promise.all(files.filter(file => file.isFile() && noticeName.test(file.name))
    .map(async ({ name }) => ({ name, bytes: await readFile(path.join(directory, name)) })));
}

function dockerNotices(crates) {
  const entries = crates.map(crate => {
    if (!/^\/usr\/local\/cargo\/registry\/src\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.+-]+\/Cargo\.toml$/.test(crate.manifest_path)) {
      throw new Error('Rust notice source is outside the Docker registry cache: ' + crate.name);
    }
    return path.posix.dirname(crate.manifest_path);
  });
  const script = [
    'set -eu',
    'index=0',
    'while IFS= read -r directory; do',
    '  test -f "$directory/Cargo.toml"',
    '  for file in "$directory"/*; do',
    '    test -f "$file" && test ! -L "$file" || continue',
    '    name=${file##*/}',
    '    case "${name,,}" in',
    '      license|license[._-]*|licence|licence[._-]*|licenses|licenses[._-]*|licences|licences[._-]*|copying|copying[._-]*|notice|notice[._-]*|copyright|copyright[._-]*|unlicense|unlicense[._-]*)',
    '        printf "%s\\t%s\\t" "$index" "$name"; base64 -w 0 "$file"; printf "\\n" ;;',
    '    esac',
    '  done',
    '  index=$((index+1))',
    'done',
  ].join('\n');
  const raw = execFileSync('docker', [
    'run', '--rm', '-i', '--mount', 'type=volume,source=forge-cargo-registry,target=/usr/local/cargo/registry,readonly',
    'forge-core-windows-dev:1.94.1', 'bash', '-c', script,
  ], { input: entries.join('\n') + '\n', encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const grouped = crates.map(() => []);
  for (const line of raw.trimEnd().split('\n').filter(Boolean)) {
    const [index, name, encoded, extra] = line.split('\t');
    if (!/^\d+$/.test(index) || !grouped[Number(index)] || !noticeName.test(name ?? '') ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded ?? '') || extra !== undefined) {
      throw new Error('Invalid notice record from the Docker build cache');
    }
    grouped[Number(index)].push({ name, bytes: Buffer.from(encoded, 'base64') });
  }
  return grouped;
}

export async function writeCargoNotices(metadata, staging, { docker = false } = {}) {
  const crates = resolvedExternalCrates(metadata);
  if (crates.length === 0) throw new Error('Cargo metadata does not identify any resolved external crate');
  const records = docker ? dockerNotices(crates) : await Promise.all(crates.map(nativeNotices));
  const directories = new Map();
  const index = [];
  for (const [position, crate] of crates.entries()) {
    let notices = records[position];
    if (notices.length === 0 && crate.name === 'alloc-stdlib' && crate.version === '0.2.4') {
      // This crate omits its repository license. The locked sibling crate ships the exact upstream bytes.
      const sibling = crates.findIndex(item => item.name === 'alloc-no-stdlib' && item.version === '2.0.4');
      const license = records[sibling]?.find(item => item.name === 'LICENSE' && digest(item.bytes) === allocatorLicenseSha256);
      if (license) notices = [license];
    }
    if (!notices.some(item => item.bytes.length > 0 && !/^notice(?:$|[._-])/i.test(item.name))) {
      throw new Error('No distributable Rust notice found for ' + crate.name + '@' + crate.version);
    }
    const versionPath = crate.version.replace('+', '_');
    if (![crate.name, versionPath, ...notices.map(item => item.name)].every(value => archiveComponent.test(value))) {
      throw new Error('Unsafe Rust notice path for ' + crate.name + '@' + crate.version);
    }
    const prefix = path.posix.join('notices', 'cargo', crate.name, versionPath);
    const destination = path.join(staging, prefix);
    await mkdir(destination, { recursive: true });
    const files = [];
    for (const notice of notices.sort((a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0))) {
      await writeFile(path.join(destination, notice.name), notice.bytes, { flag: 'wx' });
      files.push({ path: path.posix.join(prefix, notice.name), sha256: digest(notice.bytes) });
    }
    directories.set(crate.id, prefix);
    index.push({ name: crate.name, version: crate.version, license: crate.license ?? null, files });
  }
  await writeFile(path.join(staging, 'notices', 'cargo', 'index.json'), JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
  return directories;
}
