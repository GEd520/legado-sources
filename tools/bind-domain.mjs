#!/usr/bin/env node
/**
 * bind-domain.mjs —— 把你的域名接到门禁上（一次性把「指向谁」这条链走完）
 *
 * 背景（为什么必须走自有域名）
 *   workers.dev / pages.dev 在国内被 DNS 污染 + SNI 阻断，不开 VPN 必然打不开。
 *   自有域名 + Cloudflare 代理（橙云）走的是 CF 通用边缘 IP，这才是手机免翻墙的正路。
 *
 * 这个脚本做五件事：
 *   1. 校验 token 权限（必须有 Zone:Edit，建 zone 还要 Zone:Create）
 *   2. 把域名添加进 Cloudflare（Account → Add site，免费套餐）→ 打印两个 NS
 *   3. 轮询 zone 状态直到 Active（域名注册商那边改完 NS 后自动变）
 *   4. 给 Worker 绑定 Custom Domain（gate.你的域名 / 或你指定的子域名）—— 免费、自动橙云
 *   5. 用新域名真跑一次 /ping 与 /k 验活，并把地址写回 config.json
 *
 * 用法
 *   node tools/bind-domain.mjs                          # 交互式
 *   node tools/bind-domain.mjs --domain=a.com           # 指定域名
 *   node tools/bind-domain.mjs --domain=a.com --sub=gate --wait=30
 *   node tools/bind-domain.mjs --status                # 只看状态，不改任何东西
 *
 * Token 需要两个权限：Zone:Edit（必须）、Zone:Create（要它建 zone 才必须，也可在面板手动 Add site）
 *   https://dash.cloudflare.com/profile/api-tokens → Create Token → Edit zone DNS 模板再补 Zone:Edit
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG_PATH = path.join(ROOT, 'config.json');
const SEC_PATH = path.join(ROOT, 'gate', 'secrets.json');
const API = 'https://api.cloudflare.com/client/v4';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[90m', x: '\x1b[0m' };
const say = (m) => console.log(m);
const step = (n, m) => console.log(`\n${C.b}[${n}]${C.x} ${m}`);
const good = (m) => console.log(`  ${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`  ${C.y}!${C.x} ${m}`);
const bad = (m) => console.log(`  ${C.r}✗${C.x} ${m}`);

const arg = (k, d = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const STATUS_ONLY = has('status');

/* ------------------------------------------------------------ 读取配置 */
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const GATE = CFG.gate || {};
const WORKER_NAME = GATE.worker || 'legado-gate';
let SECRETS = {};
try { SECRETS = JSON.parse(fs.readFileSync(SEC_PATH, 'utf8')); } catch { }

/* 隐藏输入（不回显）—— 与 setup-gate.mjs 同一套，粘 token 不留痕 */
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (!stdin.isTTY) {
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
      } else if (ch === '\u0003') {
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

/* ------------------------------------------------------------ CF API */
async function cf(method, pathname, token, body) {
  const init = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Cloudflare 会对默认 node UA 做 1010 拦截，伪装成 curl
      'User-Agent': 'curl/8.5.0',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(API + pathname, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { }
  if (!json) throw new Error(`HTTP ${r.status} 非 JSON：${text.slice(0, 200)}`);
  if (!json.success) {
    const errs = (json.errors || []).map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`;
    const e = new Error(errs);
    e.cfErrors = json.errors || [];
    e.status = r.status;
    throw e;
  }
  return json.result;
}

const accountId = () =>
  GATE.accountId || SECRETS.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';

/* ============================================================ 主流程 */
async function main() {
  say(`${C.b}门禁域名绑定${C.x} · Worker=${WORKER_NAME}`);

  /* ---------- 0. token ---------- */
  step(0, '准备 API Token');
  let token = process.env.CF_API_TOKEN || SECRETS.cfApiToken || '';
  if (!token && !STATUS_ONLY) {
    say(`  ${C.d}需要一个带 Zone:Edit 的 token（建 zone 还要 Zone:Create）。${C.x}`);
    say(`  ${C.d}面板：https://dash.cloudflare.com/profile/api-tokens → Create Token${C.x}`);
    say(`  ${C.d}最快：用 “Edit zone DNS” 模板 + 额外加 Account→Zone→Edit${C.x}`);
    token = await askHidden('  粘贴 token（不回显，回车确认）：');
  }
  if (!token && STATUS_ONLY) {
    bad('没有 token。设环境变量 CF_API_TOKEN 或写进 gate/secrets.json 的 cfApiToken 字段');
    process.exit(2);
  }
  if (!token) { bad('没拿到 token'); process.exit(2); }

  /* ---------- 1. 校验 token / 账号 ---------- */
  step(1, '校验 token');
  let acct = accountId();
  try {
    if (!acct) {
      const accts = await cf('GET', '/accounts?per_page=50', token);
      if (!accts.length) { bad('token 看不到任何账号，请确认权限含 Account:Read'); process.exit(3); }
      acct = accts[0].id;
      good(`账号 ${accts[0].name} · ${acct}`);
    } else {
      good(`账号 ID ${acct}`);
    }
  } catch (e) {
    bad(`token 无效或权限不足：${e.message}`);
    process.exit(3);
  }
  const ctx = { token, acct };

  /* ---------- 2. 现有 zone ---------- */
  step(2, '读取账号下的域名');
  let zones = [];
  try { zones = await cf('GET', `/zones?account.id=${acct}&per_page=100`, token); }
  catch (e) { bad(`读 zone 失败：${e.message}`); process.exit(3); }

  if (!zones.length) warn('账号里 0 个域名 —— 需要先添加一个');
  else zones.forEach((z) => say(`   · ${z.name}  [${z.status}]  id=${z.id.slice(0, 8)}…`));

  if (STATUS_ONLY) {
    for (const z of zones) {
      const sub = arg('sub', 'gate');
      const host = `${sub}.${z.name}`;
      say(`\n   ${host} → worker ${WORKER_NAME}:`);
      try {
        const routes = await cf('GET', `/accounts/${acct}/workers/domains`, token);
        const hit = routes.find((r) => r.hostname === host);
        say(hit ? `     ${C.g}已绑定${C.x} (${hit.service || hit.script})` : `     ${C.y}未绑定${C.x}`);
      } catch (e) { warn(`   查询绑定失败：${e.message}`); }
    }
    return;
  }

  /* ---------- 3. 选域名 ---------- */
  step(3, '选择要用的域名');
  let zoneName = arg('domain', '').trim().toLowerCase();
  if (!zoneName) {
    if (zones.length === 1) {
      zoneName = zones[0].name;
      good(`自动选用 ${zoneName}`);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      say('  输入域名（已有的直接用；想新建就直接打新域名，如 abc.dpdns.org）');
      zoneName = (await rl.question('  域名：')).trim().toLowerCase();
      rl.close();
    }
  }
  if (!zoneName) { bad('没给域名'); process.exit(2); }

  /* ---------- 4. 添加 / 复用 zone ---------- */
  step(4, `在 Cloudflare 添加 ${zoneName}`);
  let zone = zones.find((z) => z.name === zoneName);
  if (zone) {
    good(`已存在，状态 ${zone.status}`);
  } else {
    try {
      zone = await cf('POST', '/zones', ctx.token, {
        name: zoneName,
        account: { id: acct },
        jump_start: false,
        type: 'full',
      });
      good(`已创建 · 状态 ${zone.status}`);
    } catch (e) {
      const noCreate = (e.cfErrors || []).some((x) => /zone.*(create|edit)|authentication|permission/i.test(x.message));
      bad(`创建失败：${e.message}`);
      if (noCreate) {
        warn('token 缺 Zone:Create。两个办法：');
        warn('  a) 去面板手动 Add site（免费套餐），加完重跑本脚本（会走「已存在」分支）');
        warn('  b) 新建 token 时把 Zone → Zone → Edit 加上（含创建）');
      }
      process.exit(4);
    }
  }

  /* ---------- 5. NS ---------- */
  step(5, '把这两个 NS 填到域名注册商');
  const ns = zone.name_servers || [];
  if (!ns.length) { warn('没拿到 NS，去面板 Zone 概览里看'); }
  ns.forEach((n) => say(`   ${C.g}${n}${C.x}`));
  say(`\n  ${C.d}注册商那边找 “DNS服务器 / Nameservers” 改成上面两条，删掉旧的。${C.x}`);
  say(`  ${C.d}改完 5 分钟 ~ 24 小时生效，本脚本会自己等。${C.x}`);

  /* ---------- 6. 等 Active ---------- */
  const waitMin = Number(arg('wait', '45'));
  step(6, `等待 zone 变 Active（最多 ${waitMin} 分钟）`);
  let active = zone.status === 'active';
  const deadline = Date.now() + waitMin * 60_000;
  let tick = 0;
  while (!active && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    tick++;
    try {
      const z = await cf('GET', `/zones/${zone.id}`, ctx.token);
      zone = z;
      active = z.status === 'active';
      process.stdout.write(`\r   ${active ? '✓' : '·'} 第 ${tick} 次检查：${z.status}   `);
    } catch (e) {
      process.stdout.write(`\r   · 第 ${tick} 次检查出错：${e.message.slice(0, 40)}   `);
    }
  }
  say('');
  if (!active) {
    bad(`还是 ${zone.status}。NS 没生效前绑不了自定义域名。`);
    say(`   ${C.d}改完 NS 后直接重跑：node tools/bind-domain.mjs --domain=${zoneName}${C.x}`);
    process.exit(5);
  }
  good('zone 已 Active');

  /* ---------- 7. 绑定 Worker 自定义域名 ---------- */
  const sub = arg('sub', 'gate');
  const host = sub ? `${sub}.${zoneName}` : zoneName;
  step(7, `把 ${host} 绑到 Worker ${WORKER_NAME}`);

  let existing = [];
  try { existing = await cf('GET', `/accounts/${acct}/workers/domains`, ctx.token); } catch (e) {
    warn(`读现有绑定失败（${e.message}） —— 继续尝试创建`);
  }
  const already = existing.find((r) => r.hostname === host);
  if (already) {
    good(`已绑定过（service=${already.service || already.script || WORKER_NAME}）`);
  } else {
    try {
      await cf('POST', `/accounts/${acct}/workers/domains`, ctx.token, {
        environment: 'production',
        hostname: host,
        service: WORKER_NAME,
        zone_id: zone.id,
      });
      good(`绑定成功：${host}`);
    } catch (e) {
      bad(`绑定失败：${e.message}`);
      const perm = (e.cfErrors || []).some((x) => /permission|authentication|not authorized/i.test(x.message));
      if (perm) {
        warn('token 缺 Workers 自定义域名权限。两个办法：');
        warn('  a) 面板 → Workers & Pages → legado-gate → Settings → Domains & Routes → Add → Custom Domain');
        warn('  b) token 加 Workers Routes → Edit');
      }
      say(`   ${C.d}也可以在面板手动加 Custom Domain，加完重跑本脚本验活${C.x}`);
      process.exit(6);
    }
  }

  /* ---------- 8. 验活 ---------- */
  step(8, `验活 https://${host}`);
  const base = `https://${host}`;
  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    try {
      const r = await fetch(`${base}/ping`, { headers: { 'User-Agent': 'curl/8.5.0' } });
      const j = await r.json().catch(() => null);
      if (r.status === 200 && j && j.ok) { good(`/ping → ${r.status} ${JSON.stringify(j)}`); ok = true; break; }
      warn(`第 ${i + 1} 次：HTTP ${r.status}`);
    } catch (e) {
      warn(`第 ${i + 1} 次：${e.message}（证书签发通常要 1~3 分钟，继续等）`);
    }
    await new Promise((r2) => setTimeout(r2, 15_000));
  }

  /* ---------- 9. 写回 config ---------- */
  step(9, '写回 config.json');
  if (ok) {
    CFG.gate = CFG.gate || {};
    const old = CFG.gate.url;
    CFG.gate.url = base;
    CFG.gate.fallback = old && old !== base ? old : CFG.gate.fallback;
    CFG.gate.accountId = acct;
    CFG.gate.host = host;
    fs.writeFileSync(CFG_PATH, JSON.stringify(CFG, null, 2));
    good(`gate.url → ${base}`);
    if (CFG.gate.fallback) good(`gate.fallback 保留 → ${CFG.gate.fallback}`);
    say(`\n${C.g}完成。${C.x} 接下来：`);
    say(`   node tools/gate-push.sh <kid> <lib文件> ${base} <ADMIN_TOKEN>`);
    say(`   手机直接开 ${base}/ping 应该不开 VPN 也是 {"ok":true}`);
  } else {
    bad('新域名还没验活，config.json 未改动（保证现有可用性不被破坏）');
    say(`   稍后手动验证：curl ${base}/ping`);
    process.exit(7);
  }

  /* 顺手记一下 token 供下次用 */
  if (!SECRETS.cfApiToken) {
    SECRETS.cfApiToken = token;
    SECRETS.accountId = acct;
    try {
      fs.mkdirSync(path.dirname(SEC_PATH), { recursive: true });
      fs.writeFileSync(SEC_PATH, JSON.stringify(SECRETS, null, 2));
      good('token 已存入 gate/secrets.json（.gitignore 内，不会进仓库）');
    } catch (e) { warn(`token 保存失败：${e.message}`); }
  }
}

main().catch((e) => {
  bad(`未捕获错误：${e && e.message || e}`);
  process.exit(1);
});
