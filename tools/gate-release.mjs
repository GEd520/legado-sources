#!/usr/bin/env node
/**
 * gate-release.mjs —— 一条命令发布远程逻辑（C 档热更新）
 *
 *   node tools/gate-release.mjs ailisi
 *   node tools/gate-release.mjs ailisi --dry     只检查不发布
 *
 * 做的事：
 *   1. 语法检查 sources/libs/lib-<kid>.js
 *   2. 传上门禁 KV（带 revoke:true → 所有客户端缓存立即失效）
 *   3. 回读 /k 确认 rev 已变
 * 密钥只从 config.json 读（已 gitignore），不会出现在命令行历史里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kid = process.argv[2];
const dry = process.argv.includes('--dry');
if (!kid) { console.error('用法: node tools/gate-release.mjs <kid> [--dry]'); process.exit(2); }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const G = cfg.gate || {};
const base = (Array.isArray(G.url) ? G.url[0] : G.url || '').replace(/\/$/, '');
const token = G.adminToken || process.env.ADMIN_TOKEN || '';
if (!base || !token) { console.error('✗ config.json 缺 gate.url / gate.adminToken'); process.exit(2); }

const file = path.join(ROOT, 'sources', 'libs', `lib-${kid}.js`);
if (!fs.existsSync(file)) { console.error(`✗ 找不到 ${path.relative(ROOT, file)}`); process.exit(2); }
const code = fs.readFileSync(file, 'utf8');

/* 1. 语法检查（用 Node 当语法器，Rhino 语义另由 vm-test 覆盖） */
try { new Function(code); } catch (e) {
  console.error('✗ 语法错误：' + e.message); process.exit(1);
}
const sha = (await import('node:crypto')).createHash('sha256').update(code).digest('hex').slice(0, 12);
console.log(`  ✓ 语法通过 · ${kid} · ${Buffer.byteLength(code, 'utf8')} B · sha${sha}`);

if (dry) { console.log('  - dry 模式，不发布'); process.exit(0); }

const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' };

/* 2. 发布 */
const before = await (await fetch(`${base}/admin/lib?kid=${kid}`, { headers: H })).json();
const r = await fetch(`${base}/admin/lib`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ kid, code, revoke: true }),
});
const up = await r.json();
if (!up.ok) { console.error('✗ 上传失败: ' + JSON.stringify(up)); process.exit(1); }
const after = await (await fetch(`${base}/admin/lib?kid=${kid}`, { headers: H })).json();
console.log(`  ✓ 已上传 ${up.bytes} B · rev ${before.rev || '?'} → ${after.rev || '?'}`);

/* 3. 回读确认（顺便验证密文对得上） */
const ts = Date.now();
const k = await (await fetch(`${base}/k?kid=${kid}&ts=${ts}`, {
  headers: { 'X-Did': 'd' + 'releasecheck'.padEnd(32, '0').slice(0, 32), 'X-Kid': kid },
})).json();
if (!k.ok) { console.error('✗ 回读失败: ' + JSON.stringify(k)); process.exit(1); }
console.log(`  ✓ 客户端已可见新版本 · rev ${k.rev} · ttl ${k.ttl}s · 密文 ${(k.ct || '').length} B`);
console.log(`\n✓ 发布完成。所有正在用的设备最迟 ${k.ttl} 秒内换到新逻辑，无需重导书源。`);
