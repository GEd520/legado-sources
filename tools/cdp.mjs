#!/usr/bin/env node
/**
 * cdp.mjs —— 极简 Chrome DevTools Protocol 客户端（零依赖，只用 node 内置 WebSocket）
 *
 * 用途：接管本机 Chrome，替用户把 Cloudflare 面板里的点击做完。
 *
 * 用法：
 *   node tools/cdp.mjs tabs                 列出所有标签页
 *   node tools/cdp.mjs goto <url>           在新标签打开
 *   node tools/cdp.mjs eval '<expr>' [tab]  在标签里执行 JS（tab 可为 url 片段或索引）
 *   node tools/cdp.mjs shot <name> [tab]    截图存 /tmp
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9335);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ HTTP 部分 */
async function httpJson(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) });
  return r.json();
}

export async function listTabs() {
  return (await httpJson('/json/list')).filter((t) => t.type === 'page');
}

async function newTab(url) {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(10000),
  });
  return r.json();
}

/* ------------------------------------------------------------ WS 部分 */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  async connect() {
    const { WebSocket } = globalThis;
    if (!WebSocket) throw new Error('当前 node 无内置 WebSocket（需 v22+）');
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('WS 连接超时')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(t); res(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(t); rej(new Error('WS 错误 ' + (e.message || ''))); });
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)));
        else res(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
    return this;
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP 超时: ${method}`));
      }, timeout);
      this.pending.set(id, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

async function attach(tab) {
  const c = await new CDP(tab.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  return c;
}

/* ------------------------------------------------------------ 高层动作 */
export async function evalIn(tab, expr, opts = {}) {
  const c = await attach(tab);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, opts.timeout || 30000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || 'JS 异常');
    }
    return r.result ? r.result.value : undefined;
  } finally { c.close(); }
}

export async function goto(tab, url, waitMs = 2500) {
  const c = await attach(tab);
  try {
    await c.send('Page.navigate', { url });
    await sleep(waitMs);
  } finally { c.close(); }
}

export async function shot(tab, file) {
  const c = await attach(tab);
  try {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  } finally { c.close(); }
}

/** 等某个 JS 条件成立 */
export async function waitFor(tab, expr, timeoutMs = 30000, pollMs = 800) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await evalIn(tab, expr);
      if (last) return last;
    } catch (e) { last = 'ERR ' + e.message; }
    await sleep(pollMs);
  }
  throw new Error(`waitFor 超时: ${expr} (最后值 ${JSON.stringify(last)})`);
}

/** 找标签页：给 url 片段或索引 */
export async function pickTab(sel) {
  const tabs = await listTabs();
  if (sel === undefined || sel === '') return tabs[0];
  if (/^\d+$/.test(sel)) return tabs[Number(sel)];
  const hit = tabs.find((t) => (t.url || '').includes(sel));
  if (!hit) throw new Error(`没找到标签页「${sel}」，现有：\n` + tabs.map((t, i) => `  [${i}] ${t.url}`).join('\n'));
  return hit;
}

export async function openTab(url, waitMs = 2500) {
  const t = await newTab(url);
  await sleep(waitMs);
  const tabs = await listTabs();
  return tabs.find((x) => x.id === t.id) || t;
}

/* ------------------------------------------------------------ CLI */
const isCli = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/cdp.mjs');
if (isCli) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = async () => {
    if (cmd === 'tabs') {
      const tabs = await listTabs();
      tabs.forEach((t, i) => console.log(`[${i}] ${t.title}\n     ${t.url}`));
      return;
    }
    if (cmd === 'goto') {
      const t = await openTab(args[0]);
      console.log('已打开:', t.url);
      return;
    }
    if (cmd === 'eval') {
      const t = await pickTab(args[1]);
      // 支持 @文件：复杂表达式写进 .js 文件，避免 shell 转义地狱
      let expr = args[0] || '';
      if (expr.startsWith('@')) expr = fs.readFileSync(expr.slice(1), 'utf8');
      const v = await evalIn(t, expr);
      console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : v);
      return;
    }
    if (cmd === 'click') {
      // 真鼠标事件：找元素 → 取中心坐标 → Input.dispatchMouseEvent
      const t = await pickTab(args[2]);
      const sel = args[0];
      const c = await attach(t);
      try {
        const box = await c.send('Runtime.evaluate', {
          expression: `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height),txt:(e.innerText||'').trim().slice(0,30)};})()`,
          returnByValue: true,
        });
        const b = box.result && box.result.value;
        if (!b || !b.w) { console.log('✗ 元素不存在或不可见:', sel); process.exit(1); }
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await c.send('Input.dispatchMouseEvent', {
            type, x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
          });
          await new Promise((r) => setTimeout(r, 60));
        }
        console.log(`✓ 已点击 [${b.txt}] @ (${b.x},${b.y})`);
      } finally { c.close(); }
      return;
    }
    if (cmd === 'clickxy') {
      // 按绝对坐标点一下（元素在 shadow DOM 里时用这个）
      const t = await pickTab(args[2]);
      const x = Number(args[0]), y = Number(args[1]);
      const c = await attach(t);
      try {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await c.send('Input.dispatchMouseEvent', {
            type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
          });
          await new Promise((r) => setTimeout(r, 70));
        }
        console.log(`✓ 已点击坐标 (${x},${y})`);
      } finally { c.close(); }
      return;
    }
    if (cmd === 'scroll') {
      const t = await pickTab(args[0]);
      const y = Number(args[1] || 0);
      const c = await attach(t);
      try {
        await c.send('Runtime.evaluate', { expression: `window.scrollTo(0,${y})` });
        console.log('✓ 滚到', y);
      } finally { c.close(); }
      return;
    }
    if (cmd === 'shot') {
      const t = await pickTab(args[1]);
      const dir = path.resolve(process.cwd(), 'tmp-shot');
      fs.mkdirSync(dir, { recursive: true });
      const f = await shot(t, path.join(dir, `${args[0] || 'shot'}.png`));
      console.log('已存', f);
      return;
    }
    console.log('用法: tabs | goto <url> | eval <js|@file> [tab] | click <sel> [tab] | scroll <y> [tab] | shot <name> [tab]');
  };
  run().catch((e) => { console.error('✗', e.message); process.exit(1); });
}
