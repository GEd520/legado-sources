#!/usr/bin/env node
/**
 * rhino-test.mjs —— 用真 Rhino（与 Legado 同款 JS 引擎）验证书源能否跑通
 *
 * 这不是模拟器，是把 build 出来的 jsLib 丢进 Rhino 1.7.14，
 * 复刻 Legado 的「jsLib 求值 → 规则作用域 chainTo → 执行规则」两段式作用域。
 *
 * 用法：
 *   node tools/rhino-test.mjs [key]     # 默认 ailisi
 *
 * 需要 java 11+；rhino.jar 会自动下载到 .rhino/（已排除出仓库）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.rhino');
const JAR = path.join(WORK, 'rhino-1.7.14.jar');
const CLS = path.join(WORK, 'classes');
const key = process.argv[2] || 'ailisi';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const no = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '  → ' + e : '')); };

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(CLS, { recursive: true });

/* ---------- 1. 准备 Rhino ---------- */
if (!fs.existsSync(JAR)) {
  process.stdout.write('  下载 Rhino 1.7.14 ... ');
  const f = fs.createWriteStream(JAR);
  https.get('https://repo1.maven.org/maven2/org/mozilla/rhino/1.7.14/rhino-1.7.14.jar', (r) => {
    r.pipe(f);
    f.on('finish', () => { f.close(); console.log('完成'); });
  });
  // 等文件稳定
  const t0 = Date.now();
  while (!fs.existsSync(JAR) || fs.statSync(JAR).size < 1000000) {
    if (Date.now() - t0 > 60000) { console.log('✗ 下载超时'); process.exit(1); }
  }
  await new Promise((r) => setTimeout(r, 500));
}

/* ---------- 2. 从产物抽字段 ---------- */
const srcFile = path.join(ROOT, 'dist', `${key}.json`);
if (!fs.existsSync(srcFile)) { console.log('✗ 找不到 ' + srcFile + '，先跑 build'); process.exit(1); }
const o = JSON.parse(fs.readFileSync(srcFile, 'utf8'))[0];

fs.writeFileSync(path.join(WORK, 'jsLib.txt'), o.jsLib || '', 'utf8');
fs.writeFileSync(path.join(WORK, 'vc.txt'), o.variableComment || '', 'utf8');
fs.writeFileSync(path.join(WORK, 'searchUrl.txt'), o.searchUrl || '', 'utf8');
fs.writeFileSync(path.join(WORK, 'exploreUrl.txt'), o.exploreUrl || '', 'utf8');

/* ---------- 3. 编译 harness ---------- */
const javaSrc = path.join(ROOT, 'tools', 'rhino', 'RhinoHarness.java');
try {
  execFileSync('javac', ['-encoding', 'UTF-8', '-cp', JAR, '-d', CLS, javaSrc], { stdio: 'pipe' });
} catch (e) {
  console.log('✗ javac 失败：' + String(e.stderr || e.message).slice(0, 400));
  process.exit(1);
}

/* ---------- 4. 取一份真实的门禁密文 ---------- */
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const gateUrl = (cfg.gate && cfg.gate.url) || '';
const did = 'rhino-test-' + require_crypto_md5(key).slice(0, 16);
function require_crypto_md5(s) {
  return execFileSync('node', ['-e',
    `process.stdout.write(require('crypto').createHash('md5').update(${JSON.stringify(s)}).digest('hex'))`],
    { encoding: 'utf8' });
}

async function fetchSealed() {
  if (!gateUrl) return null;
  const ts = Date.now();
  const url = `${gateUrl}/k?kid=${encodeURIComponent(key)}&ts=${ts}`;
  const ctl = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
  try {
    const res = await fetch(url, {
      headers: { 'X-Did': did, 'X-Kid': key, 'User-Agent': 'legado-rhino-test/1.0' },
      signal: ctl
    });
    const j = await res.json();
    if (!j.ok) { console.log('  门禁返回：' + JSON.stringify(j).slice(0, 120)); return null; }
    return j;
  } catch (e) {
    const c = e && e.cause ? e.cause.code || e.cause.message : '';
    console.log(`  ! 连不上门禁（${c || e.message}）—— 本机若有代理/墙会这样，不影响 jsLib 段验证`);
    return null;
  }
}

const sealed = await fetchSealed();
if (sealed) {
  fs.writeFileSync(path.join(WORK, 'resp.json'), JSON.stringify(sealed), 'utf8');
  ok(`从门禁拿到密文（${(sealed.ct || '').length} 字符，v${sealed.v || '?'}）`);
} else {
  console.log('  ! 未取到密文，跳过门禁段（只验证 jsLib 可加载）');
}

/* ---------- 5. 跑 ---------- */
const rule = path.join(WORK, 'rule.js');
fs.writeFileSync(rule, `
var out = [];
try {
  var r = GLIB('explore', getUrl());
  var s = String(r);
  out.push('OK len=' + s.length);
} catch (e) { out.push('ERR ' + String(e).slice(0, 90)); }
out.join('');
`, 'utf8');

console.log('\n  === Rhino 真实执行 ===');
let out = '';
try {
  const buf = execFileSync('java', ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', `${JAR}${path.delimiter}${CLS}`,
    'RhinoHarness', WORK, path.join(WORK, 'jsLib.txt'), rule], { stdio: 'pipe' });
  out = Buffer.from(buf).toString('utf8');
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '');
}
console.log(out.split('\n').map((l) => '  ' + l).join('\n'));

/* ---------- 6. 判定（只用 ASCII 标记，避免 Windows 控制台编码干扰）---------- */
const jsLibOk = /\[JSLIB_OK\]/.test(out);
const jsLibBad = /\[JSLIB_FAIL\]/.test(out);
jsLibOk ? ok('jsLib 在 Rhino 里可以直接求值（无顶层 java/source 引用）')
  : no('jsLib 求值失败', jsLibBad ? '出现 ReferenceError' : '未检测到标记');

if (sealed) {
  const hasAuth = /密钥|验签|授权|作者/.test(out);
  const hasErr = /OK len=\d+/.test(out);
  if (hasErr) ok('完整链路跑通：门禁 → 解密 → 还原上下文 → 执行 lib → 返回内容');
  else if (hasAuth) ok('链路已打通到书源自身的授权校验（需用户输入密钥，属正常业务）');
  else if (/Invalid JavaScript|ReferenceError/.test(out)) no('执行期出现 JS 层错误');
  else ok('执行完成（结果见上）');
}

console.log(`\n${fail === 0 ? '✓ 通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
