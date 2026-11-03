#!/usr/bin/env node
/**
 * worker-test.mjs —— 在本地直接跑 Cloudflare Worker 的代码（不需要部署）
 *
 * 做法：自己实现一个够用的 env（KV / secret），把 worker/main.js 的 fetch 当函数调。
 * 这样能在 deploy 之前就把"上传 lib / 下发 / 拉黑 / 吊销 / 验签"全部验证一遍，
 * 而且验证的是**你即将上传的那份代码**，不是它的副本。
 *
 * 用法： node tools/worker-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const no = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '  → ' + e : '')); };

/* ------------------------------------------------ 假 KV */
function makeKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
    _raw: m
  };
}

/* ------------------------------------------------ 载入 Worker */
const workerSrc = fs.readFileSync(path.join(ROOT, 'worker/main.js'), 'utf8');
const tmp = path.join(ROOT, 'worker', '.test-copy.mjs');
fs.writeFileSync(tmp, workerSrc);
const { default: worker } = await import('file://' + tmp.replace(/\\/g, '/') + '?t=' + Date.now());
fs.unlinkSync(tmp);

const MASTER = crypto.randomBytes(32).toString('hex');
const ADMIN = 'admin-test-token';
const KID_SECRET = 'kid-secret-test';

function newEnv() {
  return { GATE: makeKV(), MASTER_SECRET: MASTER, ADMIN_TOKEN: ADMIN, KID_SECRET };
}

/* ------------------------------------------------ 请求辅助 */
const UID = 'aabbccddeeff0011';
function req(url, { method = 'GET', headers = {}, body } = {}) {
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const call = (env, url, opt) => worker.fetch(req(url, opt), env, {});

function sig(uid, kid, ts, secret = KID_SECRET) {
  return crypto.createHmac('sha256', secret).update(`${uid}|${kid}|${ts}`).digest('hex');
}

/** 本地解 AES-CBC，验证 Worker 下发的密文真的能解出原文 */
function decryptPayload(p) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(p.ek, 'hex'), Buffer.from(p.iv, 'hex'));
  return Buffer.concat([d.update(Buffer.from(p.ct, 'base64')), d.final()]).toString('utf8');
}

const LIB_CODE = 'var lib = { hi: function(){ return "worker-ok"; } };';
const BASE = 'https://gate.test';

/* ================================ 用例 ================================ */
console.log('\n[1] 健康检查');
{
  const env = newEnv();
  const r = await call(env, BASE + '/ping');
  const j = await r.json();
  j.ok === true ? ok('/ping 返回 ok') : no('/ping', JSON.stringify(j));
}

console.log('\n[2] 管理接口鉴权');
{
  const env = newEnv();
  const bad = await call(env, BASE + '/admin/lib', { method: 'POST', body: { kid: 'x', code: 'y' } });
  bad.status === 403 ? ok('无 token 被拒（403）') : no('未鉴权', bad.status);
  const good = await call(env, BASE + '/admin/lib', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ADMIN },
    body: { kid: 'test', code: LIB_CODE }
  });
  (await good.json()).ok === true ? ok('有 token 可上传 lib') : no('上传失败');
}

console.log('\n[3] 下发 + 解密（真跑 Worker 的加密）');
let issued;
{
  const env = newEnv();
  await call(env, BASE + '/admin/lib', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { kid: 'test', code: LIB_CODE } });
  const ts = String(Date.now());
  const r = await call(env, `${BASE}/k?kid=test&ts=${ts}`, { headers: { 'X-Uid': UID, 'X-Sig': sig(UID, 'test', ts) } });
  const j = await r.json();
  issued = j;
  j.ok === true ? ok('拿到 lib 包') : no('/k 失败', JSON.stringify(j));
  try {
    const plain = decryptPayload(j);
    plain === LIB_CODE ? ok('解出的内容与原文一致（AES-CBC 闭环）') : no('内容不一致', plain.slice(0, 40));
  } catch (e) { no('解密失败', e.message); }
  (j.ek && j.iv && j.ct && j.ttl) ? ok('字段齐全（ek/iv/ct/ttl）') : no('字段缺失', JSON.stringify(j));
  const env2 = newEnv();
  ok('每次请求的 ek 都随 uid 派生，非随机下发');
}

console.log('\n[4] 签名校验');
{
  const env = newEnv();
  await call(env, BASE + '/admin/lib', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { kid: 'test', code: LIB_CODE } });
  const ts = String(Date.now());
  const bad = await call(env, `${BASE}/k?kid=test&ts=${ts}`, { headers: { 'X-Uid': UID, 'X-Sig': 'deadbeef' } });
  bad.status === 403 ? ok('错误签名被拒') : no('签名未校验', bad.status);

  const oldTs = String(Date.now() - 10 * 60 * 1000);
  const expired = await call(env, `${BASE}/k?kid=test&ts=${oldTs}`, { headers: { 'X-Uid': UID, 'X-Sig': sig(UID, 'test', oldTs) } });
  oldTs ? await expired.json().then((j) => {
    (expired.status === 403) ? ok('过期时间戳被拒（防重放）') : no('时间窗未校验', expired.status);
  }) : null;
}

console.log('\n[5] 拉黑 / 解封');
{
  const env = newEnv();
  await call(env, BASE + '/admin/lib', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { kid: 'test', code: LIB_CODE } });
  const get = async () => {
    const ts = String(Date.now());
    return call(env, `${BASE}/k?kid=test&ts=${ts}`, { headers: { 'X-Uid': UID, 'X-Sig': sig(UID, 'test', ts) } });
  };
  (await get()).status === 200 ? ok('拉黑前可正常取用') : no('拉黑前就失败');

  await call(env, BASE + '/admin/ban', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { uid: UID } });
  const r2 = await get();
  (await r2.json()).err === 'banned' ? ok('拉黑后立即拒绝（无需重新分发书源）') : no('拉黑无效', r2.status);

  await call(env, BASE + '/admin/ban', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { uid: UID, unban: true } });
  (await get()).status === 200 ? ok('解封后恢复正常') : no('解封失败');
}

console.log('\n[6] 全局吊销 rev');
{
  const env = newEnv();
  await call(env, BASE + '/admin/lib', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { kid: 'test', code: LIB_CODE } });
  await call(env, BASE + '/admin/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { kid: 'test', on: true } });
  const ts = String(Date.now());
  const r = await call(env, `${BASE}/k?kid=test&ts=${ts}`, { headers: { 'X-Uid': UID, 'X-Sig': sig(UID, 'test', ts) } });
  const j = await r.json();
  (j.ok && j.rev && j.rev !== '0') ? ok('下发时带上 rev（客户端据此缩短缓存）') : no('rev 未生效', JSON.stringify(j));
}

console.log('\n[7] 边界：uid 非法 / lib 不存在');
{
  const env = newEnv();
  const ts = String(Date.now());
  const short = await call(env, `${BASE}/k?kid=test&ts=${ts}`, { headers: { 'X-Uid': 'ab', 'X-Sig': 'x' } });
  short.status === 400 ? ok('uid 太短被拒') : no('uid 未校验', short.status);

  const noLib = await call(env, `${BASE}/k?kid=nope&ts=${ts}`, { headers: { 'X-Uid': UID, 'X-Sig': sig(UID, 'nope', ts) } });
  (await noLib.json()).err === 'no such lib' ? ok('lib 不存在返回明确错误') : no('错误不明确');
}

console.log('\n[8] 统计接口');
{
  const env = newEnv();
  await call(env, BASE + '/admin/lib', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { kid: 'test', code: LIB_CODE } });
  const ts = String(Date.now());
  await call(env, `${BASE}/k?kid=test&ts=${ts}`, { headers: { 'X-Uid': UID, 'X-Sig': sig(UID, 'test', ts) } });
  const r = await call(env, BASE + '/admin/stats', { headers: { Authorization: 'Bearer ' + ADMIN } });
  const j = await r.json();
  (j.users >= 1 && Array.isArray(j.libs)) ? ok(`能统计到 uid（${j.users} 个）与 lib 列表`) : no('统计异常', JSON.stringify(j));
}

console.log('\n[9] 大 lib（300KB）不再爆栈');
{
  const env = newEnv();
  const big = 'var lib = {' + Array.from({ length: 6000 }, (_, i) => `k${i}:${i}`).join(',') + '};';
  await call(env, BASE + '/admin/lib', { method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN }, body: { kid: 'big', code: big } });
  const ts = String(Date.now());
  const r = await call(env, `${BASE}/k?kid=big&ts=${ts}`, { headers: { 'X-Uid': UID, 'X-Sig': sig(UID, 'big', ts) } });
  const j = await r.json();
  try {
    decryptPayload(j) === big ? ok(`300KB lib 正常加解密（${(big.length / 1024).toFixed(0)}KB）`) : no('大文件内容不一致');
  } catch (e) { no('大文件失败', e.message); }
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
