// 灰度绑定操作：分流量给新实现，或一键回滚
//
// 用法：
//   node gate/bind.mjs status
//   node gate/bind.mjs canary --ratio 30      按 30% 流量走 canary（按人稳定散列）
//   node gate/bind.mjs pin guoshuai canary    指定某人走 canary
//   node gate/bind.mjs pin guoshuai current   指定某人走 current
//   node gate/bind.mjs rollback               回滚：ratio=0 且清空 pin

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PATH = join(here, '..', 'deploy', 'binding.json');

const cmd = process.argv[2] ?? 'status';
const b = JSON.parse(readFileSync(PATH, 'utf8'));

const save = () => {
  b.updated_at = new Date().toISOString();
  writeFileSync(PATH, JSON.stringify(b, null, 2));
  console.log('已写入', PATH);
  console.log(JSON.stringify(b, null, 2));
};

if (cmd === 'status') {
  console.log(JSON.stringify(b, null, 2));
} else if (cmd === 'canary') {
  const i = process.argv.indexOf('--ratio');
  const ratio = Number(i > 0 ? process.argv[i + 1] : 10);
  if (!(ratio >= 0 && ratio <= 100)) { console.error('ratio 要在 0–100'); process.exit(2); }
  b.ratio = ratio;
  save();
} else if (cmd === 'pin') {
  const [, , , subject, where] = process.argv;
  if (!subject || !['canary', 'current'].includes(where)) { console.error('用法：pin <主体> canary|current'); process.exit(2); }
  b.pin = { ...(b.pin ?? {}), [subject]: where };
  save();
} else if (cmd === 'rollback') {
  b.ratio = 0;
  b.pin = {};
  save();
  console.log('\n⏪ 已回滚：全部流量回到 current');
} else {
  console.error('未知命令', cmd);
  process.exit(2);
}
