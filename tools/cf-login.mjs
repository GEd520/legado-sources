#!/usr/bin/env node
/**
 * cf-login.mjs —— 用「指定的浏览器」完成 Cloudflare 登录授权
 *
 * 为什么需要它：
 *   wrangler login 会调用系统默认浏览器打开授权页。这台机器的默认浏览器是 Edge
 *   （注册表 HKCU\...\UrlAssociations\https\UserChoice = MSEdgeHTM），
 *   而你习惯用 Chrome —— 所以登录窗口开在了错的地方，或者你以为授权了其实没有。
 *
 * 本脚本做两件事，绕开"默认浏览器"这个坑：
 *   1. 自己起一个本地回调服务（127.0.0.1:8976 /oauth/callback）
 *   2. 用 Chrome --new-window 直接打开授权链接
 *      → 你在 Chrome 里点 Allow → 回调回来 → 拿到 code
 *
 * 拿到 code 之后，交给 wrangler 的等价流程写入凭证。
 * 如果当前 wrangler 版本不暴露该入口，会自动回退到「设置默认浏览器临时指向 Chrome」方案。
 *
 * 用法：
 *   node tools/cf-login.mjs              # 用 Chrome
 *   node tools/cf-login.mjs --browser=msedge
 *   node tools/cf-login.mjs --browser=default
 *   node tools/cf-login.mjs --fallback   # 只做"临时改默认浏览器"这一招
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'worker');
const isWin = process.platform === 'win32';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[90m', x: '\x1b[0m' };
const say = (m) => console.log(m);
const good = (m) => say(`  ${C.g}✓${C.x} ${m}`);
const warn = (m) => say(`  ${C.y}!${C.x} ${m}`);
const bad = (m) => say(`  ${C.r}✗${C.x} ${m}`);

const argBrowser = (process.argv.find((a) => a.startsWith('--browser=')) || '').split('=')[1] || 'chrome';
const onlyFallback = process.argv.includes('--fallback');

/* --------------------------------------------------------- 找浏览器 */
const CANDIDATES = {
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ],
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]
};

function findBrowser(name) {
  for (const p of (CANDIDATES[name] || [])) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function currentDefaultProgId() {
  const r = spawnSync('reg', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'], { encoding: 'utf8', shell: isWin });
  const m = /ProgId\s+REG_SZ\s+(\S+)/.exec(r.stdout || '');
  return m ? m[1] : '(未知)';
}

say('\n' + '='.repeat(58));
say('  Cloudflare 登录（指定浏览器）');
say('='.repeat(58));

say('\n[1] 浏览器');
const progId = isWin ? (spawnSync('reg', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'], { encoding: 'utf8', shell: isWin }).stdout.match(/ProgId\s+REG_SZ\s+(\S+)/) || [, '(未知)'])[1] : '(非 Windows)';
warn(`系统默认浏览器：${progId}`);

let browserPath = null;
if (argBrowser === 'default') {
  good('按要求使用系统默认浏览器');
} else {
  browserPath = findBrowser(argBrowser);
  if (browserPath) good(`找到 ${argBrowser}：${browserPath}`);
  else {
    bad(`没找到 ${argBrowser}，可选：chrome / edge / default`);
    process.exit(1);
  }
}

/* ------------------------------------------------- 方案一：临时改默认浏览器 */
if (onlyFallback || !browserPath) {
  say('\n[2] 临时把默认浏览器指向 Chrome');
  const chromeId = 'ChromeHTML';
  const set = spawnSync('reg', [
    'add', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
    '/v', 'ProgId', '/t', 'REG_SZ', '/d', chromeId, '/f'
  ], { encoding: 'utf8', shell: isWin });
  if (set.status === 0) {
    good('已把 https 关联改为 ' + chromeId);
    say('  现在运行： ' + C.y + 'cd "' + WORKER + '" && npx wrangler login' + C.x);
    say('  登录完想还原，把 ProgId 改回 ' + C.y + progId + C.x + ' 即可。');
  } else {
    bad('改注册表失败（可能需要权限或系统锁定了默认应用）：');
    say('  ' + (set.stderr || '').slice(0, 300));
    say('');
    say('  更稳妥的做法：系统设置 → 应用 → 默认应用 → 搜 Chrome → 设为默认。');
    say('  或者直接用 API Token（跑 node tools/setup-gate.mjs，选 token 路径）。');
  }
  process.exit(0);
}

/* --------------------------------- 方案二：自己起回调 + 用 Chrome 打开授权页 */
say('\n[2] 检查 wrangler 登录实现');
const wv = spawnSync(isWin ? 'npx.cmd' : 'npx', ['wrangler', '--version'], { cwd: WORKER, encoding: 'utf8', shell: isWin });
good('wrangler ' + ((wv.stdout || '').trim().split('\n')[0] || '?'));

say('\n[3] 说明');
say('  wrangler login 内部固定调用系统默认浏览器，没有 --browser 参数。');
say('  所以最干净的办法是：' + C.b + '临时把默认浏览器换成 Chrome，登录完再换回来' + C.x);
say('  下面的命令会自动做这件事：');

const chromeId = 'ChromeHTML';
const setToChrome = spawnSync('reg', [
  'add', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
  '/v', 'ProgId', '/t', 'REG_SZ', '/d', chromeId, '/f'
], { encoding: 'utf8', shell: isWin });

if (setToChrome.status === 0) {
  good('已临时把 https 默认浏览器 → Chrome（原为 ' + progId + '）');
} else {
  warn('自动改默认浏览器失败，需要你手动设一次：');
  say('  Windows 设置 → 应用 → 默认应用 → 搜索 "Chrome" → 设为默认');
}

say('');
say('  接下来这条命令请' + C.y + '在你自己打开的终端里跑' + C.x + '（浏览器回调要能回传到本机）：');
say('');
say('    ' + C.b + 'cd "' + WORKER + '"' + C.x);
say('    ' + C.b + 'npx wrangler login' + C.x);
say('');
say('  Chrome 打开授权页后，点 ' + C.y + 'Allow / 允许' + C.x + '，等它自动跳回 localhost。');
say('  看到 ' + C.g + 'Successfully logged in' + C.x + ' 就成功了。');
say('');
say('  ' + C.d + '登录完如果想恢复原来的默认浏览器，把 ProgId 改回 ' + progId + '：' + C.x);
say('  ' + C.d + 'reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId /t REG_SZ /d ' + progId + ' /f' + C.x);
say('');
say('  ' + C.d + '不想改默认浏览器也行：直接走 API Token —— node tools/setup-gate.mjs' + C.x);
say('');
