import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapName, canonical, fileDigest, hasWindowsInstaller, installerName, packageName, stableVersion } from './release-format.mjs';
import { verifySignedRelease } from './verify-signed-release.mjs';

export async function buildWindowsInstaller(delivery, output, version) {
  if (process.platform !== 'win32' || !stableVersion.test(version)) throw new Error('Use Windows and a numeric Forge version');
  const source = fileURLToPath(new URL('./windows/forge.iss', import.meta.url));
  const compiler = process.env.FORGE_ISCC ?? path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe');
  await mkdir(output, { recursive: true });
  execFileSync(compiler, ['/Qp', '/O' + path.resolve(output), '/DDelivery=' + path.resolve(delivery), '/DVersion=' + version, source], {
    stdio: 'inherit', windowsHide: true, timeout: 180_000,
  });
  return path.join(output, installerName(version));
}

async function assemble(directory, approvalFile, receiptFile) {
  const approval = JSON.parse(await readFile(approvalFile, 'utf8'));
  if (!hasWindowsInstaller(approval.version) || process.env.GITHUB_SHA !== approval.commitSha ||
      process.env.GITHUB_REF !== 'refs/tags/' + approval.tag) {
    throw new Error('Installer assembly must use the approved release checkout');
  }
  const anchor = process.env.FORGE_RELEASE_PUBLIC_KEY_HEX;
  const reviewed = await verifySignedRelease(directory, approval, anchor);
  const installer = await buildWindowsInstaller(directory, directory, approval.version);
  const name = path.basename(installer);
  const sha256 = await fileDigest(installer);
  const inputs = [bootstrapName(approval.version), packageName(approval.version), 'forge-release.json', 'forge-release.sig'];
  const receipt = {
    name, sha256, revision: approval.commitSha,
    inputs: Object.fromEntries(inputs.map(input => [input, reviewed.checkedFiles[input]])),
  };
  await appendFile(path.join(directory, 'SHA256SUMS'), `${sha256}  ${name}\n`);
  await verifySignedRelease(directory, approval, anchor, receipt);
  await mkdir(path.dirname(receiptFile), { recursive: true });
  await writeFile(receiptFile, canonical(receipt), { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, approval, receipt] = process.argv.slice(2);
  if (!receipt || process.argv.length !== 5) {
    throw new Error('Use build-windows-installer.mjs SIGNED_DIRECTORY APPROVAL_JSON INSTALLER_RECEIPT');
  }
  await assemble(directory, approval, receipt);
}
