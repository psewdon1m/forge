import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapName, canonical, commitFormat, fileDigest, packageName, stableVersion } from './release-format.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const [commitSha, outputArg] = process.argv.slice(2);
if (!commitFormat.test(commitSha ?? '') || !outputArg || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/package-release.mjs COMMIT_SHA NEW_OUTPUT_DIRECTORY');
}
const output = path.resolve(outputArg);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const pkg = await readJson(path.join(root, 'package.json'));
const lock = await readJson(path.join(root, 'package-lock.json'));
const version = pkg.version;
const electronVersion = pkg.devDependencies.electron;
const anchor = process.env.FORGE_RELEASE_PUBLIC_KEY_HEX;
if (!/^[a-f0-9]{64}$/.test(anchor ?? '')) throw new Error('Package build requires its embedded public key');
if (!stableVersion.test(version) || !stableVersion.test(electronVersion) || lock.version !== version ||
    lock.packages['node_modules/electron'].version !== electronVersion) throw new Error('Package versions must match lockfiles');

const binaries = path.join(root, '.local', 'bin');
const helper = path.join(binaries, 'forge-update-helper.exe');
const runtime = path.join(root, 'node_modules/electron/dist');
const rustMetadata = await readJson(path.join(root, '.local', 'release-rust-metadata.json'));
const members = new Set(rustMetadata.workspace_members);
if (rustMetadata.packages.filter(item => members.has(item.id) && item.version === version).length !== 2) {
  throw new Error('Rust workspace versions do not match the package');
}
if ((await readFile(path.join(runtime, 'version'), 'utf8')).trim() !== electronVersion) throw new Error('Installed Electron runtime does not match the lock');

await mkdir(output);
const staging = await mkdtemp(path.join(output, '.forge-package-'));
const app = path.join(staging, 'resources', 'app');
const bundle = packageName(version);
const bootstrap = bootstrapName(version);
const runtimeFiles = [
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'ffmpeg.dll', 'icudtl.dat',
  'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version',
  'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll', 'locales',
];

async function writeJson(file, value) {
  await writeFile(file, canonical(value), { flag: 'wx' });
}

function components() {
  const result = new Map();
  const track = item => result.set(item['bom-ref'], item);
  for (const [entry, item] of Object.entries(lock.packages)) {
    if (!entry || item.dev || !item.version) continue;
    const name = entry.split('node_modules/').at(-1);
    const purl = 'pkg:npm/' + (name.startsWith('@') ? '%40' + name.slice(1) : name) + '@' + item.version;
    track({ type: 'library', 'bom-ref': purl, name, version: item.version, purl });
  }
  const resolved = new Set(rustMetadata.resolve.nodes.map(node => node.id));
  for (const crate of rustMetadata.packages) {
    if (!resolved.has(crate.id)) continue;
    const purl = 'pkg:cargo/' + crate.name + '@' + crate.version;
    track({ type: members.has(crate.id) ? 'application' : 'library', 'bom-ref': purl, name: crate.name,
      version: crate.version, purl, ...(crate.license ? { licenses: [{ expression: crate.license }] } : {}),
    });
  }
  const purl = 'pkg:npm/electron@' + electronVersion;
  track({ type: 'framework', 'bom-ref': purl, name: 'Electron', version: electronVersion, purl,
    licenses: [{ license: { id: 'MIT' } }], properties: [{ name: 'forge:bundled-notices', value: 'LICENSES.chromium.html' }],
  });
  return [...result.keys()].sort().map(key => result.get(key));
}

try {
  await mkdir(path.join(staging, 'resources', 'bin'), { recursive: true });
  await mkdir(app);
  for (const relative of runtimeFiles) {
    await cp(path.join(runtime, relative), path.join(staging, relative), { recursive: relative === 'locales', errorOnExist: true, force: false });
  }
  await Promise.all([
    cp(path.join(runtime, 'electron.exe'), path.join(staging, 'Forge.exe')),
    cp(path.join(runtime, 'electron_wer.dll'), path.join(staging, 'Forge_wer.dll')),
    cp(path.join(binaries, 'forge-core.exe'), path.join(staging, 'resources', 'bin', 'forge-core.exe')),
    cp(helper, path.join(staging, 'forge-update-helper.exe')),
    cp(path.join(root, 'docs', 'licenses', 'git'), path.join(staging, 'notices', 'git'), { recursive: true }),
    cp(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true }),
    cp(path.join(root, 'apps'), path.join(app, 'apps'), { recursive: true, filter: file => {
      const relative = path.relative(path.join(root, 'apps'), file);
      return relative === '' || relative === 'desktop' || (relative.startsWith('desktop' + path.sep) && /\.(?:mjs|cjs)$/.test(relative));
    } }),
  ]);
  await writeJson(path.join(app, 'package.json'), {
    name: 'forge-desktop', productName: 'Forge', version, type: 'module', main: 'apps/desktop/main.mjs', private: true,
  });
  await writeJson(path.join(staging, 'forge-package.json'), { product: 'forge', platform: 'windows-x64', version, commitSha, electronVersion });
  execFileSync(helper, ['pack', staging, path.join(output, bundle)], { windowsHide: true, stdio: 'inherit' });
  await cp(path.join(binaries, 'forge-launcher.exe'), path.join(output, bootstrap));
  const releaseNotes = await readFile(path.join(root, 'docs', 'releases', version + '.md'), 'utf8');
  await writeFile(path.join(output, 'release-notes.md'), releaseNotes.replaceAll('\r\n', '\n'), { flag: 'wx' });
  await writeJson(path.join(output, 'forge-sbom.cdx.json'), {
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { component: { type: 'application', name: 'Forge', version } },
    components: components(),
  });
  const files = [bundle, bootstrap, 'forge-sbom.cdx.json', 'release-notes.md'];
  const subjects = await Promise.all(files.map(async name => ({ name, digest: { sha256: await fileDigest(path.join(output, name)) } })));
  await writeJson(path.join(output, 'forge-build-provenance.json'), {
    _type: 'https://in-toto.io/Statement/v1',
    subject: subjects,
    predicateType: 'https://github.com/psewdon1m/forge/provenance/build/v1',
    predicate: {
      source: { repository: 'https://github.com/psewdon1m/forge', commitSha },
      releasePublicKeySha256: createHash('sha256').update(Buffer.from(anchor, 'hex')).digest('hex'),
      builder: { workflow: process.env.GITHUB_WORKFLOW_REF ?? 'local qualification', run: process.env.GITHUB_RUN_ID ?? null },
      materials: await Promise.all(['Cargo.lock', 'package-lock.json'].map(async name => ({
        name, sha256: await fileDigest(path.join(root, name)),
      }))),
      runtime: { platform: 'windows-x64', electronVersion, node: process.versions.node },
    },
  });
  subjects.push({ name: 'forge-build-provenance.json', digest: { sha256: await fileDigest(path.join(output, 'forge-build-provenance.json')) } });
  await writeFile(path.join(output, 'SHA256SUMS'), subjects.map(item => item.digest.sha256 + '  ' + item.name + '\n').join(''), { flag: 'wx' });
  console.log(path.join(output, bundle));
} finally {
  if (path.dirname(staging) === output) await rm(staging, { recursive: true, force: true });
}
