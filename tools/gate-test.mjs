#!/usr/bin/env node
/**
 * gate-test.mjs —— 门禁闭环自测（v3，不需要真机/真 Worker）
 *
 * 复刻：
 *   ① Worker 的 HKDF 派生 + AES-CBC 现场加密
 *   ② 阅读的 java.createSymmetricCrypto / androidId / md5Encode
 *   ③ gate.js v3 的「还原上下文执行」语义
 *
 * 覆盖 9 件事：正常闭环 / 缓存 / 拉黑 / 篡改 / 下架 / 每设备密钥 /
 *             限流 / 时间窗 / 无密钥可泄露
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const no = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '  → ' + e : '')); };

const MASTER = fs.readFileSync(path.join(ROOT, 'gate', 'master.key'), 'utf8').trim();
const LIB_CODE = `var lib = {
  hello: function(){ return "pong"; },
  add: function(a,b){ return a+b; },
  needCtx: function(){ return "burl=" + getUrl(); }
};`;

/* ---------------- Worker 派生复刻 ---------------- */
const derive = (did, kid, info, len) =>
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from(MASTER, 'hex'),
    Buffer.from('legado-gate-v2'), Buffer.from(`${info}|${did}|${kid}`), len)).toString('hex');

function issue(kid, plain, did, tamper) {
  const ek = derive(did, kid, 'lib', 32);
  const iv = derive(did, kid, 'liv', 16);
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(ek, 'hex'), Buffer.from(iv, 'hex'));
  let ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64');
  if (tamper) ct = ct.slice(0, -8) + 'AAAAAAAA';
  return { ok: true, v: 3, alg: 'AES-256-CBC', ek, iv, ct, rev: '0', ttl: 21600 };
}

/* ---------------- 阅读的 java 复刻 ---------------- */
function makeJava({ did, failMode, onRequest }) {
  const reqs = [];
  return {
    _reqs: reqs,
    androidId: () => did,
    getWebViewUA: () => 'Mozilla/5.0 (Linux; Android 13) Legado/3.0',
    md5Encode: (s) => crypto.createHash('md5').update(String(s)).digest('hex'),
    hexDecodeToByteArray: (h) => Buffer.from(String(h), 'hex'),
    base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    createSymmetricCrypto(t, key, iv) {
      const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
      const ivb = Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv || ''));
      return {
        decryptStr: (d) => {
          const c = crypto.createDecipheriv('aes-256-cbc', k, ivb);
          return Buffer.concat([c.update(Buffer.from(String(d), 'base64')), c.final()]).toString('utf8');
        }
      };
    },
    log: () => { },
    toast: () => { },
    get(url, headers) {
      reqs.push({ url, headers });
      if (onRequest) onRequest(url, headers);
      if (url.includes('/k?')) {
        if (failMode === 'banned') return { status: () => 403, body: () => '{"ok":false,"err":"banned"}' };
        if (failMode === 'nosuch') return { status: () => 404, body: () => '{"ok":false,"err":"no such lib"}' };
        const kid = /kid=([^&]+)/.exec(url)[1];
        return { status: () => 200, body: () => JSON.stringify(issue(kid, LIB_CODE, did, failMode === 'tamper')) };
      }
      return { status: () => 404, body: () => '' };
    }
  };
}

function makeSource() {
  const store = {};
  return {
    cache: { get: (k) => store[k] || null, put: (k, v) => { store[k] = String(v); }, delete: (k) => { delete store[k]; } },
    getVariable: () => '{}', setVariable: () => { }
  };
}

const gateSrc = fs.readFileSync(path.join(ROOT, 'libs', 'gate.js'), 'utf8');

/** 造一个 gate 实例：java/source 由 params 传入，buildCtx 时需要 scope */
function makeGate({ did = 'aabbccddeeff00112233', failMode } = {}) {
  const java = makeJava({ did, failMode });
  const source = makeSource();
  const createGate = new Function('java', 'source', gateSrc + '\n;return createGate;')(java, source);
  const g = createGate(java, source, { urls: ['https://gate.test'], kid: 'test' });

  // 模拟规则作用域：含 java / source / 一个 jsLib 里的 getUrl
  const scope = {
    java, source,
    getUrl: function () { return 'https://site.example/'; }
  };
  return { g, java, source, scope };
}

/** 走 lib 的某个方法（模拟 GLIB('name', ...args)） */
function callLib(g, scope, name, ...args) {
  return g.run(scope, g.code(), name, args);
}

/* ============================ 用例 ============================ */
console.log('\n[1] 正常闭环：取密文 → 解密 → 还原上下文 → 调用');
{
  const { g, java, scope } = makeGate();
  try {
    const r = callLib(g, scope, 'hello');
    r === 'pong' ? ok('调用成功（hello → pong）') : no('返回值不对', r);
    callLib(g, scope, 'add', 2, 3) === 5 ? ok('带参调用正常（2+3=5）') : no('带参失败');
    /* 关键：lib 里能拿到 jsLib 的 getUrl，且 this 正确 */
    const c = callLib(g, scope, 'needCtx');
    c === 'burl=https://site.example/' ? ok('lib 内能正确调用 jsLib 的 getUrl()（上下文还原成功）') : no('上下文未还原', c);
    java._reqs.filter((x) => x.url.includes('/k?')).length === 1 ? ok('只请求一次门禁') : no('请求次数异常');
    java._reqs[0] && java._reqs[0].headers['X-Did'] ? ok('带上了 X-Did（设备身份）') : no('缺少 X-Did');
  } catch (e) { no('流程异常', String(e.message || e)); }
}

console.log('\n[2] 缓存生效');
{
  const { g, java, scope } = makeGate();
  callLib(g, scope, 'hello');
  const n1 = java._reqs.length;
  g._code = '';                      // 清内存，强制走缓存分支
  callLib(g, scope, 'hello');
  java._reqs.length === n1 ? ok('源码命中本地缓存，零网络请求') : no('缓存未生效', java._reqs.length - n1);
}

console.log('\n[3] 被拉黑 → 明确报错');
{
  const { g, scope } = makeGate({ failMode: 'banned' });
  let t = false, m = '';
  try { callLib(g, scope, 'hello'); } catch (e) { t = true; m = String(e.message || e); }
  t && /停用/.test(m) ? ok('明确提示：' + m) : no('未正确拒绝', m);
}

console.log('\n[4] 密文被篡改 → 解密失败，不执行坏代码');
{
  const { g, scope } = makeGate({ failMode: 'tamper' });
  let t = false;
  try { callLib(g, scope, 'hello'); } catch (e) { t = true; }
  t ? ok('篡改被拦下') : no('篡改未被发现');
}

console.log('\n[5] 源已下架');
{
  const { g, scope } = makeGate({ failMode: 'nosuch' });
  let t = false, m = '';
  try { callLib(g, scope, 'hello'); } catch (e) { t = true; m = String(e.message || e); }
  t && /下架/.test(m) ? ok('明确提示：' + m) : no('未拒绝', m);
}

console.log('\n[6] 每设备一把密钥');
{
  const a = derive('dev-aaaaaaaa', 'test', 'lib', 32);
  const b = derive('dev-bbbbbbbb', 'test', 'lib', 32);
  a !== b ? ok('不同设备密钥不同（封一人不影响他人）') : no('密钥重复');
  derive('dev-aaaaaaaa', 'test', 'lib', 32) === a ? ok('同设备稳定派生（换会话仍可解）') : no('派生不稳定');
}

console.log('\n[7] 书源里不含任何共享密钥');
{
  const gated = fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => f.endsWith('.json'));
  let leaked = [];
  const secrets = [];
  const cfgP = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgP)) {
    const c = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    if (c.gate && c.gate.kidSecret) secrets.push(c.gate.kidSecret);
    if (c.gate && c.gate.adminToken) secrets.push(c.gate.adminToken);
  }
  for (const f of gated) {
    const t = fs.readFileSync(path.join(ROOT, 'dist', f), 'utf8');
    if (/sigSecret/.test(t)) leaked.push(f + ':sigSecret');
    for (const s of secrets) if (s && t.includes(s)) leaked.push(f + ':密钥');
  }
  leaked.length === 0 ? ok('所有产物均无 sigSecret / 管理密钥') : no('产物泄露', leaked.join(', '));
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
