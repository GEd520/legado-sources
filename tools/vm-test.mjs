#!/usr/bin/env node
/**
 * vm-test.mjs —— 用真 Rhino 引擎做「虚拟机」端到端测试
 *
 * 为什么需要它：书源的 jsLib 在 Legado 里是 **先求值、后绑定 java/source**，
 * 且 jsLib 函数只能通过 this 取宿主。这些约束只有真引擎能验证。
 * 本次靠它抓到了 6 个「Node 里测不出来、上线必崩」的问题。
 *
 * 用法：node tools/vm-test.mjs [key]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.rhino');
const JAR = path.join(WORK, 'rhino-1.7.14.jar');
const CLS = path.join(WORK, 'classes');
const VM = path.join(WORK, 'vm');
const key = process.argv[2] || 'ailisi';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const no = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '  → ' + e : '')); };

if (!fs.existsSync(JAR)) { console.log('✗ 缺少 Rhino，先跑 tools/rhino-test.mjs'); process.exit(1); }
fs.mkdirSync(VM, { recursive: true });

/* ---------- 准备环境：从 dist 取最终字段 ---------- */
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const srcFile = path.join(ROOT, 'dist', `${key}.json`);
if (!fs.existsSync(srcFile)) { console.log('✗ 先跑 build'); process.exit(1); }
const o = JSON.parse(fs.readFileSync(srcFile, 'utf8'))[0];

const w = (n, v) => fs.writeFileSync(path.join(VM, n), v == null ? '' : String(v), 'utf8');
w('jsLib.txt', o.jsLib);
w('exploreUrl.txt', o.exploreUrl);
w('searchUrl.txt', o.searchUrl);
w('vc.txt', o.variableComment);

/* 设备身份 */
const did = 'd' + execFileSync('node', ['-e',
  `process.stdout.write(require('crypto').createHash('md5').update('legado-gate|vm-test').digest('hex').slice(0,40))`],
  { encoding: 'utf8' });
w('did.txt', did);

/* 模拟用户已在登录界面输入密钥：generateKey() = YYYY + (M+1) 两位 + 01 */
const now = new Date();
const loginKey = Buffer.from(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`, 'utf8').toString('base64');
w('login.txt', loginKey);
w('customurl.txt', '');

/* ---------- 取一份真实密文 ---------- */
const gateUrl = (cfg.gate && cfg.gate.url) || '';
let sealed = null;
if (gateUrl) {
  try {
    const ts = Date.now();
    const res = await fetch(`${gateUrl}/k?kid=${encodeURIComponent(key)}&ts=${ts}`, {
      headers: { 'X-Did': did, 'X-Kid': key }, signal: AbortSignal.timeout(15000)
    });
    const j = await res.json();
    if (j.ok) sealed = j;
  } catch (e) {
    console.log('  ! 门禁不可达（' + ((e.cause && e.cause.code) || e.message) + '），跳过在线段');
  }
}
w('resp.json', sealed ? JSON.stringify(sealed) : '{}');
if (sealed) ok(`从门禁拿到密文（${(sealed.ct || '').length} 字符，v${sealed.v}）`);

/* ---------- 编译 harness ---------- */
execFileSync('javac', ['-encoding', 'UTF-8', '-cp', JAR, '-d', CLS,
  path.join(ROOT, 'tools', 'rhino', 'RhinoHarness.java')], { stdio: 'pipe' });

/* ---------- 用例 ---------- */
function runRule(js) {
  w('rule.js', js);
  try {
    return execFileSync('java', ['-Dfile.encoding=UTF-8', '-cp', `${JAR}${path.delimiter}${CLS}`,
      'RhinoHarness', VM], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

console.log('\n[1] jsLib 能否在真 Rhino 里求值（顶层不得引用 java/source）');
{
  const out = runRule('"noop";');
  /\[JSLIB_OK\]/.test(out) ? ok('jsLib 求值通过') : no('jsLib 求值失败', out.match(/\[JSLIB_FAIL\].*/)?.[0]);
}

console.log('\n[2] 门禁 → 解密 → 还原上下文 → 执行 lib');
if (sealed) {
  const out = runRule(`
    var r = GLIB('explore', getUrl());
    var s = String(r);
    'RESULT len=' + s.length + ' useweb=' + (s.indexOf('<useweb>') >= 0) + ' doctype=' + (s.indexOf('DOCTYPE') >= 0);
  `);
  const m = out.match(/RESULT len=(\d+) useweb=(\w+) doctype=(\w+)/);
  if (m && Number(m[1]) > 5000) ok(`explore 返回完整页面（${m[1]} 字节）`);
  else no('explore 未返回有效内容', out.split('\n').filter(l => /RESULT|FAIL|ERR/.test(l)).join(' | ').slice(0, 200));
  m && m[2] === 'true' ? ok('含 <useweb> 标记') : no('<useweb> 缺失');
  m && m[3] === 'true' ? ok('含完整 HTML 文档') : no('HTML 不完整');
} else {
  console.log('  - 跳过（无密文）');
}

console.log('\n[3] 书源自带的 md5 三重校验必须对得上');
if (sealed) {
  /* 注意：Rhino 里 java.md5Encode() 返回 Java String，与 JS String 用 === 恒不等，
     必须 String() 转换后再比。 */
  const rule = [
    "var dec = String(java.aesBase64DecodeToString(source.variableComment, getSecretKey(), 'AES/ECB/PKCS7Padding', ''));",
    "var f = dec.match(new RegExp('[0-9a-f]{32}', 'g')) || [];",
    "var r = [f[0] === String(java.md5Encode(source.searchUrl)),",
    "         f[1] === String(java.md5Encode(source.jsLib)),",
    "         f[2] === String(java.md5Encode(source.exploreUrl))];",
    "'CHK ' + r.join(' ');"
  ].join('\n');
  const out = runRule(rule);
  const m = out.match(/CHK (true|false) (true|false) (true|false)/);
  if (m && m.slice(1).every((x) => x === 'true')) ok('md5(searchUrl)/md5(jsLib)/md5(exploreUrl) 三项全部一致');
  else no('自校验值不匹配', m ? m.slice(1).join(',') : out.slice(0, 140));
}

console.log('\n[4] 失败要明确报错，不能静默');
{
  // 故意清空密文，模拟门禁不可用
  const bak = fs.readFileSync(path.join(VM, 'resp.json'), 'utf8');
  w('resp.json', '{"ok":false,"err":"banned"}');
  const out = runRule(`try { GLIB('explore', getUrl()); 'NO_THROW'; } catch (e) { 'THREW ' + String(e).slice(0,60); }`);
  /THREW/.test(out) ? ok('门禁拒绝时抛出明确错误') : no('未抛出错误');
  w('resp.json', bak);
}

console.log(`\n${fail === 0 ? '✓ 虚拟机测试全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
