#!/usr/bin/env node
/**
 * chrome-login.mjs —— 不经"默认浏览器"，直接用 Chrome 打开 Cloudflare 授权页
 *
 * 原理
 *   1. 后台启动 `wrangler login` —— 它会起本地回调服务 127.0.0.1:8976 并打印授权链接
 *   2. 从它的输出里抓出 dash.cloudflare.com 的授权 URL
 *   3. 用 chrome.exe 直接打开这个 URL（--no-first-run --no-default-browser-check）
 *      → 授权回调仍然打到 wrangler 的本地服务，**跟哪个浏览器打开无关**
 *   4. 轮询输出，直到看到 "Successfully logged in"
 *
 * 这样完全绕开 Windows 的"默认浏览器"与 UserChoice 哈希校验问题。
 *
 * 用法：
 *   node tools/chrome-login.mjs
 *   node tools/chrome-login.mjs --timeout=300     # 最多等 5 分钟
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'worker');
const isWin = process.platform === 'win32';
const TIMEOUT = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1] || 240) * 1000;

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[90m', x: '\x1b[0m' };
const say = (m) => console.log(m);
const good = (m) => say(`  ${C.g}✓${C.x} ${m}`);
const warn = (m) => say(`  ${C.y}!${C.x} ${m}`);
const bad = (m) => say(`  ${C.r}✗${C.x} ${m}`);

/* ------------------------------------------------ 找 Chrome */
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
];
const chrome = CHROME_PATHS.find((p) => p && fs.existsSync(p));

say('\n' + '='.repeat(58));
say('  Cloudflare 登录 → 强制用 Chrome 打开');
say('='.repeat(58) + '\n');

if (!chrome) {
  bad('没找到 chrome.exe');
  process.exit(1);
}
good('Chrome: ' + chrome);

/* ------------------------------------------------ 启动 wrangler login */
say('\n[1] 启动 wrangler login（后台，它会开本地回调服务）');

const child = spawn(isWin ? 'npx.cmd' : 'npx', ['wrangler', 'login'], {
  cwd: WORKER,
  shell: isWin,
  env: { ...process.env, BROWSER: 'none' }   // 关键：不让它自己乱开浏览器
});

let out = '';
let urlShown = false;
let opened = false;
let done = false;

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

child.stdout.on('data', (b) => {
  const s = b.toString();
  out += s;
  process.stdout.write('  ' + C.d + stripAnsi(s).trim().slice(0, 160) + C.x + '\n');
  maybeOpen();
});
child.stderr.on('data', (b) => {
  const s = b.toString();
  out += s;
  process.stdout.write('  ' + C.d + stripAnsi(s).trim().slice(0, 160) + C.x + '\n');
  maybeOpen();
});

function maybeOpen() {
  const clean = stripAnsi(out);

  // 已经成功？
  if (/Successfully logged in|logged in/i.test(clean)) {
    if (!done) {
      done = true;
      good('登录成功！凭证已写入本机。');
      setTimeout(() => { try { child.kill(); } catch (e) { } process.exit(0); }, 500);
    }
    return;
  }

  // 抓授权链接
  if (opened) return;
  const m = /(https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?[^\s"'<>]+)/.exec(clean);
  if (!m) return;

  urlShown = true;
  const url = m[1];
  say('\n[2] 已拿到授权链接');
  say('  ' + C.b + url.slice(0, 110) + '…' + C.x);
  say('\n[3] 用 Chrome 打开');

  const p = spawn(chrome, ['--new-window', '--no-first-run', '--no-default-browser-check', url], {
    detached: true,
    stdio: 'ignore'
  });
  p.unref();
  opened = true;
  good('已交给 Chrome（如果没弹窗，看下面手动链接）');

  say('');
  say('  ' + C.y + '请在 Chrome 里点「Allow / 允许」' + C.x + '，等它跳回 localhost:8976。');
  say('  ' + C.d + '自动跳回后不用操作，脚本会自己发现成功。' + C.x);
  say('');
  say('  ' + C.d + '手动备份链接（万一 Chrome 没弹）：' + C.x);
  say('  ' + C.d + url + C.x);
  say('');
}

child.on('exit', (code) => {
  if (!done) {
    const clean = stripAnsi(out);
    if (/Successfully logged in/i.test(clean)) {
      done = true;
      good('登录成功！');
      process.exit(0);
    }
    bad('wrangler login 退出（code=' + code + '）');
    if (/Timed out/i.test(clean)) {
      say('');
      warn('超时：说明 Chrome 里没有完成授权，或者回调 8976 没通。');
      say('  可能原因：');
      say('    1. 授权页没点 Allow');
      say('    2. 本机 8976 端口被防火墙/代理拦截');
      say('');
      say('  兜底方案（最稳）：直接用 API Token');
      say('    ' + C.b + '$env:CLOUDFLARE_API_TOKEN="你的token"' + C.x);
      say('    ' + C.b + 'node tools/setup-gate.mjs' + C.x);
    }
    say('');
    say('  完整输出：');
    say(clean.slice(-800));
    process.exit(1);
  }
});

/* 超时保护 */
setTimeout(() => {
  if (done || opened) return;
  if (!urlShown) {
    bad('等了 ' + (TIMEOUT / 1000) + ' 秒还没拿到授权链接');
    say(out.slice(-800));
    try { child.kill(); } catch (e) { }
    process.exit(1);
  }
}, TIMEOUT);
