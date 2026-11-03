/**
 * seal.mjs —— 把 lib 源码 / 书源敏感字段加密成"只有过门禁才解得开"的密文
 *
 * 用法（在 订阅源控制/ 目录下）：
 *   node tools/seal.mjs --kid ailisi --file libs/lib-ailisi.js
 *   node tools/seal.mjs --kid ailisi --text 'var x=1'
 *   node tools/seal.mjs --kid ailisi --string  # 生成一段可粘贴的守卫壳
 *
 * 输出示例：
 *   { "kid":"ailisi", "v":1, "iv":"...", "ct":"...", "hk":"..." }
 *   hk = HMacHex(master, 'hk|' + kid)  —— 用来让客户端自检"口令对不对"，
 *        不泄露 master（HMAC 不可逆）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const KID = get('kid');
if (!KID && !has('genmaster')) { console.error('缺 --kid'); process.exit(1); }

/* master 从环境变量或 gate/master.key 读（后者 gitignore） */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const keyFile = path.join(ROOT, 'gate', 'master.key');
let MASTER = process.env.MASTER_SECRET;
if (!MASTER && fs.existsSync(keyFile)) MASTER = fs.readFileSync(keyFile, 'utf8').trim();

if (has('genmaster')) {
  const k = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.join(ROOT, 'gate'), { recursive: true });
  fs.writeFileSync(keyFile, k + '\n', 'utf8');
  console.log('已生成 gate/master.key（32 字节 hex）');
  console.log('⚠️ 这个文件不要提交、不要外发。丢了 = 所有人的 lib 都要重发。');
  process.exit(0);
}

if (!MASTER) {
  console.error('缺 master：先运行  node tools/seal.mjs --genmaster');
  process.exit(1);
}

/* HKDF：master + kid → 固定密钥（与 Worker 的 deriveKey 保持一致，但这里不含 uid，
   因为静态文件要能被所有用户解密；真正的"每人一把"用于运行时更换） */
function derive(info, len = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(MASTER, 'hex'), Buffer.from('legado-seal-v1'), Buffer.from(info), len));
}

function seal(plain, kid) {
  const key = derive('seal|' + kid, 32);
  const iv = crypto.createHash('sha256').update('iv|' + kid + '|' + MASTER).digest().subarray(0, 16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64');
  const hk = crypto.createHmac('sha256', Buffer.from(MASTER, 'hex')).update('hk|' + kid).digest('hex').slice(0, 32);
  return { kid, v: 1, alg: 'AES-256-CBC', iv: iv.toString('hex'), ct, hk };
}

/* ---------------------------------------------------------------- 主流程 */
const file = get('file');
const text = get('text');

let plain = null, target = null;
if (file) { plain = fs.readFileSync(file, 'utf8'); target = file; }
else if (text) plain = text;
else if (has('string') || has('json') === false) { /* 只要 key 相关输出 */ }

const out = {};
if (plain !== null) {
  out[KID] = seal(plain, KID);
  const distDir = path.join(ROOT, 'dist', 'libs');
  fs.mkdirSync(distDir, { recursive: true });
  const outFile = path.join(distDir, `gate-${KID}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`✓ ${target || 'stdin'} → ${path.relative(ROOT, outFile)}`);
  console.log(`  明文 ${plain.length} B → 密文 ${out[KID].ct.length} B（base64）`);
  console.log(`  iv=${out[KID].iv}`);
  console.log(`  hk=${out[KID].hk}`);
} else {
  const s = seal('PING', KID);
  console.log(JSON.stringify({ kid: s.kid, iv: s.iv, hk: s.hk }, null, 2));
}

/* --------------------------------------------- 打印一段可直接粘的守卫壳 */
if (has('string')) {
  const s = out[KID] || seal('PING', KID);
  console.log('\n---- 粘进书源 jsLib 顶部 ----\n');
  console.log(`/* GATE-BEGIN */
var GATE = {
  url: '${get('gate', 'https://REPLACE-ME.workers.dev')}',
  kid: '${KID}',
  iv: '${s.iv}',
  hk: '${s.hk}'
};
/* GATE-END */`);
}
