#!/usr/bin/env node
/**
 * obf.mjs —— 构建前把要进仓库的库文件混淆
 *
 * 为什么需要：仓库是 Public 的。libs/*.js 是明文源码，等于把门禁客户端、
 * 加速降级、热更新机制整套送人。混淆后：
 *   · 仓库里只剩 dist-src/ 的产物（可提交）
 *   · 明文源码留在本机 libs/（已 gitignore）
 *
 * 注意：混淆后的代码仍要在真 Rhino 里跑通 —— JavaScript 混淆器常用
 * ES5+ 语法，Rhino 1.7.14 只认 ES5，所以构建后必须重跑 vm-test。
 *
 *   node scripts/obf.mjs           # 生成 dist-src/*.js
 *   node scripts/obf.mjs --check   # 只检查产物是否最新
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'libs');
const OUT = path.join(ROOT, 'dist-src');
const CHECK = process.argv.includes('--check');

/* 这些名字会被 build.mjs 拼进 jsLib 并被源码规则调用，必须保留 */
const KEEP = ['createGate', 'createHub', 'createHot', 'buildPanel'];

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
if (!files.length) { console.error('✗ libs/ 为空'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const manifest = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(SRC, f), 'utf8');
  const tmp = path.join(OUT, '.tmp-' + f);
  const dst = path.join(OUT, f);
  try {
    execFileSync('npx', ['--yes', 'javascript-obfuscator', path.join(SRC, f), '--output', tmp,
      '--compact', 'true',
      '--identifier-names-generator', 'hexadecimal',
      '--string-array', 'true',
      '--string-array-encoding', 'base64',
      '--string-array-threshold', '0.75',
      '--control-flow-flattening', 'false',      // Rhino 上风险高，且体积翻倍
      '--self-defending', 'false',
      '--dead-code-injection', 'false',
      '--rename-globals', 'false',
      '--reserved-names', KEEP.join(','),
    ], { stdio: 'pipe', timeout: 180000 });
    const code = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    // 混淆器会加一行 // javascript-obfuscator 注释头，去掉
    const clean = code.replace(/^\/\/\s*javascript-obfuscator.*$/m, '').replace(/^\s+/, '');
    fs.writeFileSync(dst, clean, 'utf8');
    manifest.push({ name: f, src: Buffer.byteLength(src, 'utf8'), out: Buffer.byteLength(clean, 'utf8'),
      sha: (await import('node:crypto')).createHash('sha256').update(clean).digest('hex').slice(0, 12) });
    console.log(`  ✓ ${f.padEnd(14)} ${manifest.at(-1).src} → ${manifest.at(-1).out} B`);
  } catch (e) {
    fs.existsSync(tmp) && fs.unlinkSync(tmp);
    console.error(`  ✗ ${f}: ${String(e.stderr || e.message).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) {
  fs.writeFileSync(path.join(OUT, 'manifest.json'),
    JSON.stringify({ built: new Date().toISOString(), files: manifest }, null, 2), 'utf8');
  console.log(`\n✓ 产物在 dist-src/（可提交）；明文源码只在 libs/（已 gitignore）`);
}
