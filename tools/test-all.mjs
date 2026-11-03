#!/usr/bin/env node
/**
 * test-all.mjs —— 一键跑全部测试
 *
 *   node tools/test-all.mjs            全部
 *   node tools/test-all.mjs --offline   跳过联网段（墙内/代理环境）
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');

const suites = [
  ['worker-test', 'Worker 单元（设备身份/限流/封禁/加密）'],
  ['gate-test', '门禁闭环（缓存/篡改/下架/上下文还原）'],
  ['simulate', '全流程模拟（订阅源/控制台/热更新）'],
  ['vm-test', '虚拟机：真 Rhino 引擎端到端'],
];

const results = [];
for (const [name, desc] of suites) {
  const f = path.join(ROOT, 'tools', `${name}.mjs`);
  if (!fs.existsSync(f)) { results.push([name, desc, 'SKIP', '文件不存在']); continue; }
  process.stdout.write(`\n━━ ${name.padEnd(12)} ${desc}\n`);
  try {
    const out = execFileSync('node', [f, ...(offline ? [] : [])], { encoding: 'utf8', stdio: 'pipe', timeout: 240000 });
    const tail = out.trim().split('\n').filter((l) => /通过|失败|✓|✗/.test(l));
    const summary = tail.find((l) => /通过/.test(l)) || tail[tail.length - 1] || '';
    const failed = /✗|有失败/.test(out) ? 'FAIL' : 'PASS';
    results.push([name, desc, failed, summary.replace(/^[✓✗]\s*/, '')]);
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const summary = out.trim().split('\n').filter((l) => /通过|失败|Error/.test(l)).pop() || String(e.message).slice(0, 80);
    results.push([name, desc, 'FAIL', summary.slice(0, 100)]);
  }
}

console.log('\n' + '═'.repeat(74));
console.log('汇总');
console.log('═'.repeat(74));
let bad = 0;
for (const [n, d, st, s] of results) {
  if (st === 'FAIL') bad++;
  const mark = st === 'PASS' ? '✓' : st === 'SKIP' ? '-' : '✗';
  console.log(`  ${mark} ${n.padEnd(12)} ${st.padEnd(5)} ${s}`);
}
console.log('═'.repeat(74));
console.log(bad === 0 ? '✓ 全部通过' : `✗ ${bad} 组失败`);
process.exitCode = bad ? 1 : 0;
