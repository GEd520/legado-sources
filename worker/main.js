/**
 * Cloudflare Worker —— 书源门禁（v2：lib 不进仓库）
 * -----------------------------------------------------------------
 * 设计要点
 *   仓库里**一份 lib 明文/密文都没有**。lib 存在 KV 里（CF 静态加密），
 *   每次请求由 Worker 用「该 uid 专属的密钥」现场加密后下发。
 *   → 扒仓库 = 拿到 30 行壳子，什么都没有
 *   → 扒网络 = 只有自己那份密文，且每个 uid 密文不同
 *   → 拉黑某人 = 他再也换不到，且不需要重新分发任何文件
 *
 * 路由
 *   GET  /ping                          健康检查
 *   GET  /k?kid=<key>&ts=<ms>           换取本机 lib（X-Did / X-Kid 必带，设备身份）
 *   POST /admin/lib   {kid, code}       上传/更新 lib；带 revoke:true 立即吊销客户端缓存
 *   GET  /admin/lib[?kid=]              列表 / 查看大小与 rev
 *   DELETE /admin/lib?kid=              下架 lib
 *   POST /admin/ban   {uid} / {uid,unban}
 *   POST /admin/revoke {on:true|false}  全局吊销（强制所有人重新取）
 *   GET  /admin/stats
 *
 * 环境变量
 *   MASTER_SECRET   ≥32 字节随机串（wrangler secret put）
 *   ADMIN_TOKEN     管理口令
 *   RATE_LIMIT      每设备每小时最多请求次数（默认 30）
 * 绑定
 *   KV: GATE
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'X-Uid,X-Sig,Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Cache-Control': 'no-store'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (url.pathname === '/ping') return json({ ok: true, t: Date.now() }, cors);
      if (url.pathname === '/k') return await issueLib(request, env, url, cors);
      if (url.pathname.startsWith('/admin/')) return await admin(request, env, url, cors);
      return json({ ok: false, err: 'not found' }, cors, 404);
    } catch (e) {
      return json({ ok: false, err: String((e && e.message) || e) }, cors, 500);
    }
  }
};

/* ------------------------------------------------------------- /k 下发 */
async function issueLib(request, env, url, cors) {
  const did = (request.headers.get('X-Did') || '').trim();
  const kid = (url.searchParams.get('kid') || '').trim();
  const ts = Number(url.searchParams.get('ts') || 0);

  if (!did || did.length < 8 || did.length > 64) return json({ ok: false, err: 'bad did' }, cors, 400);
  if (!kid) return json({ ok: false, err: 'missing kid' }, cors, 400);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000) {
    return json({ ok: false, err: 'bad ts' }, cors, 400);
  }
  if (await env.GATE.get('ban:' + did)) return json({ ok: false, err: 'banned' }, cors, 403);

  const sealed = await env.GATE.get('lib:' + kid);
  if (!sealed) return json({ ok: false, err: 'no such lib' }, cors, 404);
  const rev = (await env.GATE.get('rev:' + kid)) || '0';

  /* ---------------- 计数 + 限流 ---------------- */
  const rec = 'uid:' + did;
  const raw = await env.GATE.get(rec);
  const o = raw ? JSON.parse(raw) : { first: Date.now(), calls: 0, hour: 0, hourAt: 0 };
  const now = Date.now();

  // 滑动小时窗，超过上限直接拒（防批量刷）
  const LIMIT = Number(env.RATE_LIMIT || 30);
  if (!o.hourAt || now - o.hourAt > 3600 * 1000) { o.hour = 0; o.hourAt = now; }
  if (o.hour >= LIMIT) {
    await env.GATE.put(rec, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 90 });
    return json({ ok: false, err: 'too fast' }, cors, 429);
  }

  o.calls = (o.calls || 0) + 1;
  o.hour = (o.hour || 0) + 1;
  o.last = now;
  o.kid = kid;
  await env.GATE.put(rec, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 90 });

  /* 每设备一把：key = HKDF(master, "lib|did|kid") */
  const ek = await deriveBits(env.MASTER_SECRET, did, kid, 'lib', 32);
  const iv = await deriveBits(env.MASTER_SECRET, did, kid, 'liv', 16);
  const ct = await aesEncrypt(hexToBytes(ek), hexToBytes(iv), sealed);

  // rev 变化时客户端缓存要缩短，做到「发新版本 → 旧客户端尽快换新」
  const ttl = rev !== '0' ? 300 : 21600;

  return json({ ok: true, v: 3, alg: 'AES-256-CBC', ek, iv, ct, rev, ttl, serverTime: now }, cors);
}

/* ------------------------------------------------------------ 管理接口 */
async function admin(request, env, url, cors) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ ok: false, err: 'forbidden' }, cors, 403);

  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  if (url.pathname === '/admin/stats') {
    const users = await env.GATE.list({ prefix: 'uid:' });
    const libs = await env.GATE.list({ prefix: 'lib:' });
    const libInfo = [];
    for (const k of libs.keys) {
      const id = k.name.replace('lib:', '');
      const code = await env.GATE.get(k.name);
      libInfo.push({ kid: id, bytes: code ? code.length : 0, rev: (await env.GATE.get('rev:' + id)) || '0' });
    }
    return json({ ok: true, users: users.keys.length, libs: libInfo.map((x) => x.kid), libInfo }, cors);
  }

  if (url.pathname === '/admin/lib') {
    // DELETE /admin/lib?kid=xxx  下架一个 lib
    if (request.method === 'DELETE') {
      const kid = url.searchParams.get('kid');
      if (!kid) return json({ ok: false, err: 'kid required' }, cors, 400);
      await env.GATE.delete('lib:' + kid);
      await env.GATE.delete('rev:' + kid);
      return json({ ok: true, kid, deleted: true }, cors);
    }
    // GET /admin/lib?kid=xxx  查看某个 lib（含大小与是否吊销）
    if (request.method === 'GET') {
      const kid = url.searchParams.get('kid');
      if (!kid) {
        const l = await env.GATE.list({ prefix: 'lib:' });
        return json({ ok: true, libs: l.keys.map((k) => k.name.slice(4)) }, cors);
      }
      const code = await env.GATE.get('lib:' + kid);
      if (code === null) return json({ ok: false, err: 'no such lib' }, cors, 404);
      return json({ ok: true, kid, bytes: code.length, rev: await env.GATE.get('rev:' + kid) || '0' }, cors);
    }
    // POST 上传/更新
    if (!body.kid || typeof body.code !== 'string') return json({ ok: false, err: 'kid + code required' }, cors, 400);
    if (body.code.length > 500 * 1024) return json({ ok: false, err: 'lib too large (max 500KB)' }, cors, 400);
    await env.GATE.put('lib:' + body.kid, body.code);
    if (body.revoke) await env.GATE.put('rev:' + body.kid, String(Date.now()));
    return json({ ok: true, kid: body.kid, bytes: body.code.length }, cors);
  }

  if (url.pathname === '/admin/ban') {
    const target = body.did || body.uid;
    if (!target) return json({ ok: false, err: 'did required' }, cors, 400);
    if (body.unban) await env.GATE.delete('ban:' + target);
    else await env.GATE.put('ban:' + target, '1');
    return json({ ok: true, did: target, banned: !body.unban }, cors);
  }

  /* 列出所有设备（用于定位泄露 / 封禁） */
  if (url.pathname === '/admin/users') {
    const l = await env.GATE.list({ prefix: 'uid:' });
    const out = [];
    for (const k of l.keys.slice(0, 200)) {
      const v = await env.GATE.get(k.name);
      out.push(Object.assign({ did: k.name.slice(4) }, v ? JSON.parse(v) : {}));
    }
    return json({ ok: true, count: l.keys.length, users: out }, cors);
  }

  if (url.pathname === '/admin/revoke') {
    const kid = body.kid || url.searchParams.get('kid');
    if (!kid) return json({ ok: false, err: 'kid required' }, cors, 400);
    const on = body.on === undefined ? url.searchParams.get('on') !== '0' : !!body.on;
    if (on) await env.GATE.put('rev:' + kid, String(Date.now()));
    else await env.GATE.delete('rev:' + kid);
    return json({ ok: true, kid, rev: await env.GATE.get('rev:' + kid) }, cors);
  }

  return json({ ok: false, err: 'unknown admin route' }, cors, 404);
}

/* --------------------------------------------------------------- 工具 */
function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}
const enc = new TextEncoder();
const hexToBytes = (h) => new Uint8Array(String(h).match(/.{2}/g).map((x) => parseInt(x, 16)));
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function checkSig(kid, uid, ts, sig, secret) {
  if (!sig || !ts) return false;
  const t = Number(ts);
  if (!isFinite(t) || Math.abs(Date.now() - t) > 5 * 60 * 1000) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${uid}|${kid}|${ts}`));
  return toHex(mac) === String(sig).toLowerCase();
}

async function deriveBits(master, uid, kid, info, len) {
  const base = await crypto.subtle.importKey('raw', enc.encode(master), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('legado-gate-v2'), info: enc.encode(`${info}|${uid}|${kid}`) },
    base, len * 8
  );
  return toHex(bits);
}

async function aesEncrypt(keyBytes, ivBytes, plainUtf8) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const buf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ivBytes }, key, enc.encode(plainUtf8));
  const bytes = new Uint8Array(buf);
  // 分块 btoa：大 lib 用展开运算符会爆栈
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
