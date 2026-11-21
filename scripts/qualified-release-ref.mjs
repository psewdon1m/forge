import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { commitFormat, stableVersion } from './release-format.mjs';

export const origin = 'https://github.com/psewdon1m/forge.git';

export function matchQualifiedRef({ ref, version, commit, refs }) {
  const tag = 'forge-v' + version;
  if (!stableVersion.test(version ?? '') || ref !== 'refs/tags/' + tag || !commitFormat.test(commit ?? '')) {
    throw new Error('Qualified release tag must exactly match the package version and full commit');
  }
  const tagCommit = refs.get(ref + '^{}') ?? refs.get(ref);
  if (refs.get('refs/heads/main') !== commit || tagCommit !== commit) {
    throw new Error('The qualified release tag, checked-out commit and remote main must be identical');
  }
  return { version, tag, commit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ref = process.argv[2] ?? process.env.GITHUB_REF;
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (ref !== 'refs/tags/forge-v' + version || !stableVersion.test(version)) throw new Error('Not a qualified Forge release tag');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
  const commit = git('rev-parse', 'HEAD');
  const output = git('ls-remote', '--exit-code', origin, 'refs/heads/main', ref, ref + '^{}');
  const refs = new Map(output.split(/\r?\n/).map(line => line.split('\t').reverse()));
  console.log(JSON.stringify(matchQualifiedRef({ ref, version, commit, refs })));
}
