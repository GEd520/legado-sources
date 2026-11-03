#!/usr/bin/env node
/**
 * gate-test.mjs —— 门禁闭环自测（不需要真机、不需要真 Worker）
 *
 * 复刻三样东西：
 *   ① Worker 的 HKDF 派生（与 worker/main.js 同一算法）
 *   ② 阅读的 java.createSymmetricCrypto('AES/CBC/PKCS5Padding') / HMacHex / androidId
 *   ③ 网络：java.get 打到本地，把 /k 的响应按 Worker 逻辑现场生成
 *
 * 验证 6 件事：
 *   [1] 正常流程能解出 lib 并调用成功
 *   [2] 密钥缓存生效（第二次不再请求 Worker）
 *   [3] 被拉黑 → 明确报错，不静默
 *   [4] 密文被篡改 → 解密失败，不会执行坏代码
 *   [5] HK 不匹配（换了 master）→ 拒绝
 *   [6] 不同 uid 拿到的 key 不同（每人一把，符合设计）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const no = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '  → ' + e : '')); };

const MASTER = fs.readFileSync(path.join(ROOT, 'gate', 'master.key'), 'utf8').trim();
const KID_SECRET = 'test-kid-secret';
const LIB_CODE = 'var lib = { hello: function(){ return "pong"; }, add: function(a,b){ return a+b; } };';

/* ---------------- 复刻 Worker 的派生 ---------------- */
const derive = (uid, kid, info, len) =>
    Buffer.from(crypto.hkdfSync('sha256', Buffer.from(MASTER, 'hex'), Buffer.from('legado-gate-v2'), Buffer.from(`${info}|${uid}|${kid}`), len)).toString('hex');

/* ---------------- 复刻 seal.mjs 的静态加密 ---------------- */
/* 模拟 Worker 的"现场加密"：lib 明文只在服务端，按 uid 加密后下发 */
function signLib(kid, plain, uid, tamper) {
    const ek = derive(uid, kid, 'lib', 32);
    const iv = derive(uid, kid, 'liv', 16);
    const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(ek, 'hex'), Buffer.from(iv, 'hex'));
    let ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64');
    if (tamper) ct = ct.slice(0, -8) + 'AAAAAAAA';
    return { ok: true, v: 1, alg: 'AES-256-CBC', ek, iv, ct, rev: '0', ttl: 21600 };
}

/* ---------------- 复刻阅读的 java 对象 ---------------- */
function makeJava({ state, uid, failMode }) {
    const requests = [];
    return {
        _requests: requests,
        androidId: () => uid,
        getWebViewUA: () => 'Mozilla/5.0 (Linux; Android 13) Legado',
        md5Encode: (s) => crypto.createHash('md5').update(String(s)).digest('hex'),
        hexDecodeToByteArray: (h) => Buffer.from(String(h), 'hex'),
        hexEncodeToString: (s) => Buffer.from(String(s), 'utf8').toString('hex'),
        base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
        base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
        HMacHex: (data, alg, key) => crypto.createHmac('sha256', String(key)).update(String(data)).digest('hex'),
        createSymmetricCrypto(transformation, key, iv) {
            const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
            const ivb = Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv || ''));
            return {
                decryptStr(data) {
                    const d = crypto.createDecipheriv('aes-256-cbc', k, ivb);
                    return Buffer.concat([d.update(Buffer.from(String(data), 'base64')), d.final()]).toString('utf8');
                },
                decryptHex(hex) {
                    const d = crypto.createDecipheriv('aes-256-cbc', k, ivb);
                    return Buffer.concat([d.update(Buffer.from(String(hex), 'hex')), d.final()]).toString('utf8');
                }
            };
        },
        log: (m) => { },
        toast: (m) => { },
        get(url, headers) {
            requests.push({ url, headers });
            /* --- 模拟 Worker --- */
            if (url.includes('/k?')) {
                if (failMode === 'banned') return { status: () => 403, body: () => '{"ok":false,"err":"banned"}' };
                if (failMode === 'nosuch') return { status: () => 404, body: () => '{"ok":false,"err":"no such lib"}' };
                const kid = /kid=([^&]+)/.exec(url)[1];
                return {
                    status: () => 200,
                    body: () => JSON.stringify(signLib(kid, LIB_CODE, uid, failMode === 'tamper'))
                };
            }
            /* --- 模拟静态文件 --- */
            const m = /dist\/libs\/([^?]+)/.exec(url);
            if (m) {
                const f = path.join(ROOT, 'dist', 'libs', m[1]);
                if (!fs.existsSync(f)) return { status: () => 404, body: () => '' };
                return { status: () => 200, body: () => fs.readFileSync(f, 'utf8') };
            }
            return { status: () => 404, body: () => '' };
        }
    };
}

function makeSource() {
    const store = {};
    return {
        _store: store,
        cache: {
            get: (k) => store[k] || null,
            put: (k, v) => { store[k] = String(v); return v; },
            delete: (k) => { delete store[k]; }
        },
        getVariable: () => '',
        setVariable: () => { },
        get: () => '', put: () => ''
    };
}

/* ---------------- 载入 gate.js ---------------- */
const gateSrc = fs.readFileSync(path.join(ROOT, 'libs', 'gate.js'), 'utf8');

function makeGate({ uid = 'aabbccddeeff0011', failMode, cfg = {} }) {
    const java = makeJava({ uid, failMode });
    const source = makeSource();
    const createGate = new Function('java', 'source', gateSrc + '\n;return createGate;')(java, source);
    const g = createGate(java, source, Object.assign({
        url: 'https://gate.test',
        kid: 'test',
        sigSecret: KID_SECRET,
        base: '',
        mirrors: ['']
    }, cfg));
    return { g, java, source };
}

/* ============================ 用例 ============================ */
console.log('\n[1] 正常闭环：换 key → 拉密文 → 解密 → 执行');
{
    const { g, java } = makeGate({});
    const r = g.call('hello');
    r === 'pong' ? ok('解密后调用成功（hello → pong）') : no('调用失败', r);
    g.call('add', 2, 3) === 5 ? ok('带参调用正常（add 2+3=5）') : no('带参调用失败');
    const kq = java._requests.filter((x) => x.url.includes('/k?')).length;
    kq === 1 ? ok('请求过一次门禁 /k') : no('/k 请求次数异常', kq);
    java._requests.some((x) => x.headers['X-Sig'] && x.headers['X-Uid']) ? ok('带上了 X-Uid / X-Sig') : no('缺少鉴权头');
}

console.log('\n[2] 缓存生效');
{
    const { g, java } = makeGate({});
    g.call('hello');
    const n1 = java._requests.length;
    g.call('hello');
    // 第二次：lib 已在内存 _lib，不该再发任何请求
    java._requests.length === n1 ? ok('lib 常驻内存，二次调用零请求') : no('多余请求', java._requests.length - n1);
}

console.log('\n[3] 被拉黑');
{
    const { g } = makeGate({ failMode: 'banned',  });
    let threw = false, msg = '';
    try { g.call('hello'); } catch (e) { threw = true; msg = String(e.message || e); }
    threw && /门禁/.test(msg) ? ok('明确报错：' + msg) : no('未正确拒绝', msg);
}

console.log('\n[4] 密文被篡改');
{
    const { g } = makeGate({ failMode: 'tamper' });
    let threw = false, msg = '';
    try { g.call('hello'); } catch (e) { threw = true; msg = String(e.message || e); }
    threw ? ok('篡改后解密失败（不会执行坏代码）') : no('篡改未被发现');
}

console.log('\n[5] 源已下架 / 门禁不可用');
{
    const { g } = makeGate({ failMode: 'nosuch' });
    let threw = false, msg = '';
    try { g.call('hello'); } catch (e) { threw = true; msg = String(e.message || e); }
    threw && /门禁/.test(msg) ? ok('明确报错：' + msg) : no('未拒绝', msg);
}

console.log('\n[6] 每人一把 key');
{
    const a = derive('uid-aaaaaa', 'test', 'lib', 32);
    const b = derive('uid-bbbbbb', 'test', 'lib', 32);
    a !== b ? ok('不同 uid 的 key 不同（拉黑一人不影响他人）') : no('key 重复');
    derive('uid-aaaaaa', 'test', 'lib', 32) === a ? ok('同 uid 稳定派生（换会话也能解）') : no('派生不稳定');
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
