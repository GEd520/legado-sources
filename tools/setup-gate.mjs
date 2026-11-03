#!/usr/bin/env node
/**
 * setup-gate.mjs —— Cloudflare 门禁一键部署（有账号的从这一步开始）
 *
 * 做七件事，每一步都会停下来告诉你结果：
 *   1. 检查 node / wrangler / 登录状态
 *   2. 跑本地验证（worker-test 17 项 + gate-test 10 项）—— 不过就不往下走
 *   3. 生成/读取 master、ADMIN_TOKEN、KID_SECRET
 *   4. 创建 KV namespace 并自动写回 wrangler.toml
 *   5. 上传三个 secret
 *   6. wrangler deploy
 *   7. 部署完立刻用真实地址跑一次 /ping 与 /k，确认线上真的能用
 *
 * 用法：
 *   node tools/setup-gate.mjs              # 交互式（推荐）
 *   node tools/setup-gate.mjs --check      # 只做环境检查，不部署
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'worker');
const isWin = process.platform === 'win32';
const CHECK_ONLY = process.argv.includes('--check');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[90m', x: '\x1b[0m' };

/** 隐藏输入（不回显），用于粘贴 token */
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (!stdin.isTTY) {
      // 非交互（管道）时退化为明文读一行
      const rl = readline.createInterface({ input: stdin });
      rl.question('', (a) => { rl.close(); resolve(a.trim()); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(wasRaw || false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf.trim());
      } else if (ch === '\u0003') {           // Ctrl+C
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}
const say = (m) => console.log(m);
const step = (n, m) => console.log(`\n${C.b}[${n}]${C.x} ${m}`);
const good = (m) => console.log(`  ${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`  ${C.y}!${C.x} ${m}`);
const bad = (m) => console.log(`  ${C.r}✗${C.x} ${m}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: WORKER, encoding: 'utf8', shell: isWin,
    env: { ...process.env },
    ...opts
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const npx = () => (isWin ? 'npx.cmd' : 'npx');

/* ------------------------------------------------------------ 1. 环境 */
step(1, '环境检查');
const nodeVer = process.version;
good(`Node ${nodeVer}`);

let wranglerVer = run(npx(), ['wrangler', '--version']);
if (wranglerVer.code !== 0) {
  bad('没找到 wrangler');
  say('  先装（或直接用 npx 自动下载）：');
  say('    npm i -g wrangler   # 或者每次用 npx wrangler');
  process.exit(1);
}
good('wrangler 可用：' + wranglerVer.out.trim().split('\n')[0]);

/* --- 认证：优先 API Token（不依赖浏览器回调），其次 OAuth --- */
const secretsPath = path.join(ROOT, 'gate', 'secrets.json');
let savedSecrets = {};
try { if (fs.existsSync(secretsPath)) savedSecrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (e) { }

let CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || savedSecrets.CF_API_TOKEN || '';

async function fetchAccounts(token) {
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'token 无效');
  return j.result || [];
}

if (!CF_TOKEN) {
  const who = run(npx(), ['wrangler', 'whoami']);
  const loggedIn = /You are logged in|associated with the email/i.test(who.out);
  if (loggedIn) {
    const email = (who.out.match(/[\w.+-]+@[\w.-]+\.\w+/) || ['(已登录)'])[0];
    good('已通过 OAuth 登录：' + email);
  } else {
    warn('尚未认证（浏览器登录账号 ≠ 授权 wrangler，需要 API Token 或完成回调）');
    say('');
    say('  ' + C.b + '推荐：用 API Token（不依赖浏览器回调，最稳）' + C.x);
    say('  1) 打开 ' + C.y + 'https://dash.cloudflare.com/profile/api-tokens' + C.x);
    say('  2) Create Token → 选模板 ' + C.y + 'Edit Cloudflare Workers' + C.x + ' → Continue → Create');
    say('  3) 复制 token，粘到下面（不会回显、不会写进历史）');
    say('');
    if (!process.stdin.isTTY) {
      bad('当前不是交互终端，无法输入。请改用：');
      say('  set CLOUDFLARE_API_TOKEN=你的token   （cmd）');
      say('  $env:CLOUDFLARE_API_TOKEN="你的token"   （PowerShell）');
      say('  再重跑 node tools/setup-gate.mjs');
      process.exit(2);
    }
    CF_TOKEN = await askHidden('  粘贴 API Token: ');
    if (!CF_TOKEN) { bad('没有输入 token'); process.exit(2); }

    try {
      const accts = await fetchAccounts(CF_TOKEN);
      if (!accts.length) throw new Error('这个 token 看不到任何账号');
      good('Token 有效，账号：' + accts.map((a) => a.name).join(', '));
      process.env.CLOUDFLARE_ACCOUNT_ID = accts[0].id;
      good('Account ID：' + accts[0].id);
    } catch (e) {
      bad('Token 校验失败：' + e.message);
      process.exit(2);
    }
    savedSecrets.CF_API_TOKEN = CF_TOKEN;
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify(savedSecrets, null, 2), 'utf8');
    good('已保存到 gate/secrets.json（.gitignore 已排除，下次不用再输）');
  }
} else {
  good('使用 API Token 认证');
  try {
    const accts = await fetchAccounts(CF_TOKEN);
    if (accts.length) {
      process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || accts[0].id;
      good('账号：' + accts.map((a) => a.name).join(', ') + ' / ' + process.env.CLOUDFLARE_ACCOUNT_ID);
    }
  } catch (e) { warn('Token 校验告警：' + e.message); }
}

/* ------------------------------------------------------ 2. 本地先验一遍 */
step(2, '本地验证（不过就不部署）');
for (const t of ['worker-test.mjs', 'gate-test.mjs']) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', t)], { encoding: 'utf8' });
  const tail = (r.stdout || '').trim().split('\n').pop();
  if (r.status === 0) good(`${t} → ${tail}`);
  else { bad(`${t} 失败`); say((r.stdout || '') + (r.stderr || '')); process.exit(3); }
}

if (CHECK_ONLY) { say('\n仅检查模式，到此为止。'); process.exit(0); }

/* --------------------------------------------------------- 3. 三个密钥 */
step(3, '准备密钥');
const gateDir = path.join(ROOT, 'gate');
fs.mkdirSync(gateDir, { recursive: true });
const secretsFile = path.join(gateDir, 'secrets.json');

function loadOrCreateSecrets() {
  if (fs.existsSync(secretsFile)) {
    try {
      const o = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
      if (!o.MASTER_SECRET) o.MASTER_SECRET = crypto.randomBytes(32).toString('hex');
      if (!o.ADMIN_TOKEN) o.ADMIN_TOKEN = crypto.randomBytes(24).toString('base64url');
      if (!o.KID_SECRET) o.KID_SECRET = crypto.randomBytes(24).toString('base64url');
      return o;
    } catch (e) { }
  }
  const s = {
    MASTER_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_TOKEN: crypto.randomBytes(24).toString('base64url'),
    KID_SECRET: crypto.randomBytes(24).toString('base64url'),
    created: new Date().toISOString()
  };
  fs.writeFileSync(secretsFile, JSON.stringify(s, null, 2), 'utf8');
  return s;
}
const S = loadOrCreateSecrets();
fs.writeFileSync(path.join(gateDir, 'master.key'), S.MASTER_SECRET + '\n', 'utf8');
good('master / admin / kid 密钥已就绪（gate/secrets.json，已在 .gitignore）');
say(`  ${C.d}ADMIN_TOKEN = ${S.ADMIN_TOKEN}${C.x}`);
say(`  ${C.d}（这个 token 要留着，后面上传 lib、拉黑设备都要用）${C.x}`);

/* 若用 token 认证，写一个 .dev.vars 之外的临时环境（wrangler 优先读环境变量） */
if (CF_TOKEN) {
  process.env.CLOUDFLARE_API_TOKEN = CF_TOKEN;
}

/* -------------------------------------------------------- 4. KV 命名空间 */
step(4, '创建 KV namespace');
let kvId = '';
const tomlPath = path.join(WORKER, 'wrangler.toml');
let toml = fs.readFileSync(tomlPath, 'utf8');

const already = /id\s*=\s*"([0-9a-f]{32})"/.exec(toml);
if (already) {
  kvId = already[1];
  good('wrangler.toml 里已有 KV id：' + kvId);
} else {
  say('  正在创建…（如果提示重名，会自动复用）');
  const r = run(npx(), ['wrangler', 'kv', 'namespace', 'create', 'GATE']);
  const m = /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(r.out);
  if (m) {
    kvId = m[1];
    toml = toml.replace('REPLACE_WITH_KV_ID', kvId);
    fs.writeFileSync(tomlPath, toml, 'utf8');
    good('已创建并写回 wrangler.toml：' + kvId);
  } else if (/already exists|10014/i.test(r.out)) {
    warn('同名 namespace 已存在，列出已有的：');
    const list = run(npx(), ['wrangler', 'kv', 'namespace', 'list']);
    say(list.out);
    say('  把上面 GATE 对应的 id 手动填进 worker/wrangler.toml 的 REPLACE_WITH_KV_ID，再重跑本脚本。');
    process.exit(4);
  } else {
    bad('创建失败：');
    say(r.out);
    process.exit(4);
  }
}

/* ------------------------------------------------------------ 5. secrets */
step(5, '上传 secrets');
function putSecret(name, value) {
  const r = spawnSync(npx(), ['wrangler', 'secret', 'put', name], {
    cwd: WORKER, input: value + '\n', encoding: 'utf8', shell: isWin
  });
  const outp = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0 || /Success|Uploaded/i.test(outp)) return true;
  // 有些版本要求在 TTY 里输入；给出兜底提示
  return { err: outp };
}
for (const k of ['MASTER_SECRET', 'ADMIN_TOKEN', 'KID_SECRET']) {
  const r = putSecret(k, S[k]);
  if (r === true) good(k + ' 已上传');
  else {
    warn(k + ' 自动上传失败，请手动执行：');
    say(`  cd "${WORKER}" && npx wrangler secret put ${k}   # 粘贴：${S[k]}`);
  }
}

/* ------------------------------------------------------------- 6. 部署 */
step(6, '部署 Worker');
const dep = run(npx(), ['wrangler', 'deploy']);
say(dep.out.trim().split('\n').slice(-12).join('\n'));
const urlMatch = /(https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev)/i.exec(dep.out);
if (!urlMatch) {
  bad('没从输出里找到 workers.dev 地址，请把上面的输出发我。');
  process.exit(5);
}
const GATE_URL = urlMatch[1];
good('部署成功：' + GATE_URL);

/* ------------------------------------------------------- 7. 线上真跑一次 */
step(7, '线上验证');
async function tryFetch(u, opt) {
  try {
    const r = await fetch(u, opt);
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: String(e) }; }
}
{
  const ping = await tryFetch(GATE_URL + '/ping');
  ping.status === 200 ? good('/ping 通（' + ping.text.slice(0, 60) + '）') : bad('/ping 失败：HTTP ' + ping.status + ' ' + ping.text.slice(0, 120));

  const ts = String(Date.now());
  const uid = 'selftest-' + crypto.randomBytes(4).toString('hex');
  const sig = crypto.createHmac('sha256', S.KID_SECRET).update(`${uid}|selftest|${ts}`).digest('hex');
  const k = await tryFetch(`${GATE_URL}/k?kid=selftest&ts=${ts}`, { headers: { 'X-Uid': uid, 'X-Sig': sig } });
  // 此时还没上传 lib，预期是 404 no such lib —— 说明门禁逻辑已经在线工作
  let j = {};
  try { j = JSON.parse(k.text); } catch (e) { }
  (k.status === 404 && j.err === 'no such lib')
    ? good('/k 已在线工作（lib 还没上传，故返回 no such lib，符合预期）')
    : warn(`/k 返回 ${k.status}：${k.text.slice(0, 120)}`);
}

/* --------------------------------------------------------------- 收尾 */
const cfgPath = path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.gate = { url: GATE_URL, kidSecret: S.KID_SECRET, adminToken: S.ADMIN_TOKEN };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
good('已写入 config.json 的 gate 段（供后面生成书源用）');

say('\n' + '='.repeat(60));
say(`${C.g}门禁已就位${C.x}`);
say('  Worker   : ' + GATE_URL);
say('  管理口令 : ' + S.ADMIN_TOKEN);
say('  下一步   : 把某个源的逻辑做成 lib 并上传：');
say(`             bash tools/gate-push.sh <kid> <lib文件> ${GATE_URL} ${S.ADMIN_TOKEN}`);
say('='.repeat(60));
say(`\n${C.d}提醒：gate/secrets.json 与 gate/master.key 都不要提交、不要外发。${C.x}\n`);
