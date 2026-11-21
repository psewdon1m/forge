import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../.docs/', import.meta.url));
const checkout = path.dirname(directory);
const plan = await readFile(path.join(directory, 'Forge_Production_Plan_v0.1.md'), 'utf8');
const stages = [...plan.matchAll(/^### (F\d{2})\./gm)];
assert.deepEqual(stages.map(stage => stage[1]), Array.from({ length: 11 }, (_, i) => 'F' + String(i).padStart(2, '0')));
for (const [index, stage] of stages.entries()) {
  const section = plan.slice(stage.index, stages[index + 1]?.index ?? plan.indexOf('## 8.'));
  for (const label of ['Вход', 'Работы', 'Выход', 'Приёмка']) {
    assert(section.includes('**' + label + '.**'), stage[1] + ' is missing ' + label);
  }
}
for (const [, link] of plan.matchAll(/\]\((\.{1,2}\/[^\s)]+)\)/g)) {
  const target = path.resolve(directory, decodeURIComponent(link.split('#', 1)[0]));
  const relative = path.relative(checkout, target);
  assert(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'Plan link escapes the Forge checkout: ' + link);
  await access(target);
}
assert(plan.includes('(../docs/adr/0003-forge-visual-profile.md)') && plan.includes('(../ui/src/style.css)'),
  'The production plan must link to the distributed design profile and styles');
console.log('Forge plan stage blocks, checkout links and design references verified.');
