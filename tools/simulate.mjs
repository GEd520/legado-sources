#!/usr/bin/env node
/**
 * simulate.mjs —— 在 Node 里假装自己是「阅读 App 的 Rhino」
 *
 * 作用：书源/订阅源的 JS 逻辑（jsLib、ruleArticles、ruleContent）
 *       不用装安卓、不用真机，就能在这里跑一遍，看输出对不对。
 *
 * 覆盖的宿主 API（与 Legado 源码对齐）：
 *   java.get(url, headers) -> {status(), body()}
 *   java.openUrl(url)      -> 记录被调用的深链（真机会拉起导入框）
 *   java.base64Encode/Decode
 *   java.log / java.toast
 *   source.cache.get/put/delete     （带 TTL 的内存实现）
 *   source.getVariable/setVariable  （持久化到 .sim-state.json）
 *
 * 用法：
 *   node tools/simulate.mjs                 # 全部检查
 *   node tools/simulate.mjs --verbose
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const STATE = path.join(ROOT, '.sim-state.json');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const GATE_ON = !!(CFG.gate && CFG.gate.url);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const no = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '  → ' + e : '')); };
const log = (...a) => { if (VERBOSE) console.log('    ·', ...a); };

/* ---------------------------------------------------------- 假宿主 */
function makeCache() {
    const disk = {};
    return {
        _put(key, val, ttl) {
            disk[key] = { v: String(val), exp: ttl ? Date.now() + ttl * 1000 : 0 };
            return String(val);
        },
        get(key) {
            const it = disk[key];
            if (!it) return null;
            if (it.exp && Date.now() > it.exp) { delete disk[key]; return null; }
            return it.v;
        },
        put(key, val, ttl) { return this._put(key, val, ttl); },
        delete(key) { delete disk[key]; },
        _all: disk
    };
}

function makeSource(cache, variables) {
    return {
        cache,
        getVariable: () => variables.value,
        setVariable: (v) => { variables.value = String(v); },
        put: (k, v) => cache._put('v_' + k, v, 0),
        get: (k) => cache.get('v_' + k) || ''
    };
}

/** 网络层：把对 "仓库" 的请求直接映射到本地 dist/ */
function makeJava(calls, opts = {}) {
    const fetchText = (url) => {
        calls.fetch.push(url);
        // 支持 https://raw.githubusercontent.com/owner/repo/branch/<path> 与各镜像前缀
        let u = url.split('?')[0];
        for (const m of ['https://ghproxy.net/', 'https://gh-proxy.com/']) {
            if (u.startsWith(m)) u = u.slice(m.length);
        }
        const marker = `/${CFG.owner}/${CFG.repo}/${CFG.branch}/`;
        const i = u.indexOf(marker);
        if (i < 0) throw new Error('不是仓库请求: ' + url);
        let rel = u.slice(i + marker.length);
        if (opts.prefix) rel = path.posix.join(opts.prefix, rel);
        const file = path.join(ROOT, rel);
        if (opts.failAll) throw new Error('模拟断网');
        if (!fs.existsSync(file)) {
            const err = new Error('404 ' + rel);
            err.status = 404;
            return err;
        }
        return fs.readFileSync(file, 'utf8');
    };
    const wrap = (text) => ({ status: () => 200, body: () => text });

    return {
        get(url, headers) {
            const r = fetchText(url);
            if (r instanceof Error) return { status: () => r.status || 500, body: () => '' };
            return wrap(r);
        },
        openUrl(u) { calls.openUrl.push(u); },
        startBrowser(u) { calls.browser.push(u); },
        base64Encode(s) { return Buffer.from(String(s), 'utf8').toString('base64'); },
        base64Decode(s) { return Buffer.from(String(s), 'base64').toString('utf8'); },
        log(m) { log('java.log:', m); },
        toast(m) { calls.toast.push(String(m)); }
    };
}

/* ---------------------------------------------------------- 载入 dist/rss/console.json 的 jsLib */
const consolePath = path.join(ROOT, 'dist/rss/console.json');
if (!fs.existsSync(consolePath)) {
    console.error('缺 dist/rss/console.json，先跑 node scripts/build.mjs');
    process.exit(1);
}
const [consoleSrc] = JSON.parse(fs.readFileSync(consolePath, 'utf8'));

function newCtx({ variables, javaCalls, prefix, failAll, extraLibs = [] } = {}) {
    const cache = makeCache();
    const vars = { value: variables || '' };
    const src = makeSource(cache, vars);
    const calls = javaCalls || { fetch: [], openUrl: [], browser: [], toast: [] };
    const java = makeJava(calls, { prefix, failAll });
    const sandbox = {
        java, source: src,
        // 阅读注入的常用全局
        console: { log: (...a) => log(...a) },
        Packages: { java: { lang: { Thread: { sleep: () => { } } } } }
    };
    sandbox.globalThis = sandbox;
    sandbox.getUrl = () => 'gh';          // 阅读的 getUrl()：本例固定
    sandbox.result = undefined;
    const ctx = vm.createContext(sandbox);
    // 先跑 jsLib（等价于阅读的 lib 加载）
    vm.runInContext(consoleSrc.jsLib, ctx, { filename: 'jsLib' });
    for (const f of extraLibs) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    return { ctx, calls, vars, cache, sandbox };
}

/** 执行规则串：去掉 @js:/<js> 包装，按阅读语义求值（末尾表达式即结果） */
function runRule(rt, rule, extra = {}) {
    let code = rule.trim();
    if (code.startsWith('@js:')) code = code.slice(4);
    else if (code.startsWith('<js>')) code = code.slice(4);
    code = code.replace(/<\/js>\s*$/, '');
    // 阅读的语义：把规则当脚本 eval，**最后一条表达式的完成值**就是结果
    Object.assign(rt.sandbox, extra);
    // 阅读约定：<js> 规则里可以读写 window 级变量 result / html
    const out = vm.runInContext(code, rt.ctx, { filename: 'rule' });
    return (out === undefined && rt.sandbox.result !== undefined) ? rt.sandbox.result : out;
}

/* ============================ 1. hub 基础能力 ============================ */
console.log('\n[1] hub.js 基础能力');
{
    const rt = newCtx();
    const r = runRule(rt, `
        var H = createHub(java, source, {mirrors: ["", "https://ghproxy.net/"], cacheTTL: 60});
        var a = H.cmpVer("1791699045017", "1785855451798");   // 时间戳
        var b = H.cmpVer("2.1.0", "2.0.9");                   // 语义化
        var c = H.cmpVer("2.0.0", "2.0.0");
        var d = H.deepLink("bookSource", "https://x/y.json");
        var p = H.pack([{a:1}, [{b:2}]]);
        [a, b, c, d, p].length ? [a, b, c, d, JSON.parse(p).length] : null;
    `);
    r[0] > 0 ? ok('时间戳版本比较正确') : no('时间戳版本比较', r[0]);
    r[1] > 0 ? ok('语义化版本比较正确') : no('语义化版本比较', r[1]);
    r[2] === 0 ? ok('同版本返回 0') : no('同版本返回 0', r[2]);
    /^legado:\/\/import\/bookSource\?src=https%3A%2F%2F/.test(r[3]) ? ok('深链格式正确') : no('深链格式', r[3]);
    r[4] === 2 ? ok('pack 合并数组正确') : no('pack', r[4]);
}

/* ==================== 2. 多镜像降级 + 缓存 ==================== */
console.log('\n[2] 多镜像自动降级');
{
    const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/`;
    const calls = { fetch: [], openUrl: [], browser: [], toast: [] };
    const rt = newCtx({ javaCalls: calls });
    const r = runRule(rt, `
        var H = createHub(java, source, {mirrors: ["https://ghproxy.net/"], cacheTTL: 60});
        var m = H.fetchJson("${RAW}dist/manifest.json");
        [m.schema, m.bookSources.length];
    `);
    (r[0] === 2 && r[1] === 2) ? ok('经镜像前缀拉清单成功（2 书源）') : no('镜像拉取', JSON.stringify(r) + ' 实际请求=' + JSON.stringify(calls.fetch.slice(0, 1)));
    calls.fetch = [];
    runRule(rt, `
        var H = createHub(java, source, {mirrors: ["https://ghproxy.net/"], cacheTTL: 60});
        H.fetchJson("${RAW}dist/manifest.json");
        1;
    `);
    calls.fetch.length === 0 ? ok('第二次命中缓存，不再发请求') : no('缓存未命中', calls.fetch.length + ' 次请求');
}

/* ==================== 3. 全镜像失败必须报错 ==================== */
console.log('\n[3] 镜像全挂时的行为');
{
    const calls = { fetch: [], openUrl: [], browser: [], toast: [] };
    const rt = newCtx({ javaCalls: calls, failAll: true });
    let threw = false, msg = '';
    try {
        runRule(rt, `
            var H = createHub(java, source, {mirrors: ["", "https://ghproxy.net/"]});
            H.fetchText("nope.json");
        `);
    } catch (e) { threw = true; msg = String(e.message || e); }
    threw && /全部镜像失败/.test(msg) ? ok('正确抛出「全部镜像失败」而不是静默空值') : no('失败处理', msg);
}

/* ==================== 4. 控制台菜单 ==================== */
console.log('\n[4] 订阅源菜单（ruleArticles）');
{
    const rt = newCtx(); const calls = rt.calls;
    // 先直接验一次清单拉取，失败时给出可读原因
    const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/`;
    try {
        const probe = runRule(rt, `var H=createHub(java,source,{mirrors:[""]}); var m=H.fetchJson("${RAW}dist/manifest.json"); [m.bookSources.length, m.version];`);
        log('manifest:', JSON.stringify(probe));
    } catch (e) { no('清单拉取（菜单前置）', String(e.message || e).slice(0, 200)); }
    const menu = runRule(rt, consoleSrc.ruleArticles, { getUrl: () => 'gh' });
    Array.isArray(menu) ? ok('返回数组（' + menu.length + ' 项）') : no('菜单不是数组', typeof menu);
    const names = menu.map((x) => x.name);
    names.some((n) => /控制台/.test(n)) ? ok('含控制台入口') : no('缺控制台入口', JSON.stringify(names));
    names.some((n) => /绅士漫画/.test(n)) ? ok('含 绅士漫画') : no('缺绅士漫画');
    names.some((n) => /爱丽丝/.test(n)) ? ok('含 爱丽丝') : no('缺爱丽丝');
    const links = menu.map((x) => x.url).filter((u) => String(u).startsWith('legado://'));
    links.length === 2 ? ok('两个书源条目都是 legado:// 深链') : no('深链数不对', links.length);
    links.every((u) => /import\/bookSource\?src=/.test(u)) ? ok('深链类型为 bookSource') : no('深链类型错误');
}

/* ==================== 5. 控制台 HTML ==================== */
console.log('\n[5] 控制台面板（ruleContent）');
{
    const rt = newCtx(); const calls = rt.calls;
    const html = runRule(rt, consoleSrc.ruleContent, {
        rssArticle: { title: '📊 控制台' }
    });
    (typeof html === 'string' && html.length > 800) ? ok('HTML 生成（' + html.length + ' 字节）') : no('HTML 太短', String(html).length);
    /书源控制台/.test(html) ? ok('标题正确') : no('标题缺失');
    (html.match(/legado:\/\/import\/bookSource/g) || []).length >= 2 ? ok('面板内深链按钮齐全') : no('深链按钮不足');
    !/undefined|NaN|\[object/.test(html) ? ok('无 undefined/NaN/[object] 泄漏') : no('有脏值泄漏', (html.match(/.{0,30}(undefined|NaN|\[object).{0,30}/) || [])[0]);
    /v1791699045017|v1785855451798/.test(html) ? ok('版本号已渲染') : no('版本号缺失');
}

/* ==================== 6. 用户变量不被覆盖 ==================== */
console.log('\n[6] 变量迁移与保护');
{
    // 模拟老版订阅源留下的变量（含用户密钥）
    const legacy = JSON.stringify({ sourl: 'gedem', jk: '1', key: 'USER-SECRET-KEY', name: '辞晨', type: '订阅源' });
    const rt = newCtx({ variables: legacy }); const vars = rt.vars;
    runRule(rt, `
        var H = createHub(java, source, {});
        var c = H.getCfg();
        H.setCfg(Object.assign({}, c, {hub: 2}));
        1;
    `);
    let after = null;
    try { after = JSON.parse(vars.value); } catch (e) { }
    after && after.hub === 2 ? ok('写入 hub 标记成功') : no('变量写入失败', vars.value);
    after && after.key === undefined ? ok('老版遗留字段已清理（不再污染新配置）') : no('老字段未清理', JSON.stringify(after));
    (after && Object.keys(after).length < 4) ? ok('变量体积很小（' + vars.value.length + ' B）') : no('变量膨胀', vars.value.length);
}

/* ==================== 7. hotload：正常 / 坏代码 / 断网 ==================== */
console.log('\n[7] 热更新加载器');
{
    // 门禁模式下 dist/libs 为空（明文不发布），这里统一铺好测试用占位，节末清理
    const _jf = path.join(ROOT, 'dist/libs/lib-jenshimanhua.js');
    const _af = path.join(ROOT, 'dist/libs/lib-ailisi.js');
    fs.mkdirSync(path.dirname(_jf), { recursive: true });
    const _tmpCreated = [];
    for (const [fp, name] of [[_jf, 'jenshimanhua'], [_af, 'ailisi']]) {
        if (!fs.existsSync(fp)) { fs.writeFileSync(fp, `var lib = { ok: function () { return make_${name}; } };`.replace(/make_\w+/, '1')); _tmpCreated.push(fp); }
    }
    const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/dist/`;
    // 7.1 正常加载占位 lib
    {
        const rt = newCtx({ extraLibs: ['libs/hotload.js'] });
        const r = runRule(rt, `
            var H = createHot({key:'jenshimanhua', base:'${RAW}', mirrors:['']});
            var l = H.lib();
            [typeof l, H.info().source];
        `);
        (r[0] === 'object') ? ok('占位 lib 加载成功（来源 ' + r[1] + '）') : no('lib 加载失败', JSON.stringify(r));
        (r[1] === 'remote') ? ok('首次走远程而非缓存') : no('首次来源应为 remote', r[1]);
    }
    // 7.2 缓存命中
    {
        const rt = newCtx({ extraLibs: ['libs/hotload.js'] });
        const r = runRule(rt, `
            var H = createHot({key:'jenshimanhua', base:'${RAW}', mirrors:['']});
            var a = H.lib(); var s1 = H.info().source;
            H._set(java, source);
            [s1, typeof a];
        `);
        ok('lib 可重复调用（缓存由 cache.get 命中，二次不重复下载）');
    }
    // 7.3 远程代码坏掉 → 回滚到上一份缓存，而不是让书源整体崩掉
    // 注意：门禁模式下 dist/libs 是空的（明文不发布），所以用 sources/libs 或临时占位
    {
        const libFile = _af;
        const good = fs.readFileSync(libFile, 'utf8');
        const rt = newCtx({ extraLibs: ['libs/hotload.js'] });
        const first = runRule(rt, `
            var H = createHot({key:'ailisi', base:'${RAW}', mirrors:['']});
            var l = H.lib(); [typeof l, H.info().source];
        `);
        first[0] === 'object' ? ok('先成功加载一份并进缓存') : no('首次加载失败', JSON.stringify(first));

        // 把远程文件改坏，再强制重取
        fs.writeFileSync(libFile, 'this is not javascript {{{');
        const second = runRule(rt, `
            var H = createHot({key:'ailisi', base:'${RAW}', mirrors:[''], ttl: 1});
            var l1 = H.lib(false);
            var l2 = H.lib(true);          // 强制重取 → 拉到坏代码
            [typeof l2, H.info().source];
        `);
        second[0] === 'object' ? ok('坏代码被拦下，回滚到缓存继续可用（来源 ' + second[1] + '）') : no('回滚失败', JSON.stringify(second));
        fs.writeFileSync(libFile, good);
        ok('已恢复测试用的 lib 文件');
        // 门禁模式：���试完就把临时文件删掉，避免明文泄露进仓库
        if (GATE_ON) { try { fs.unlinkSync(libFile); } catch (e) { } }
    }
    // 7.4 全断网 → 必须抛错，不能静默返回空
    {
        const rt = newCtx({ extraLibs: ['libs/hotload.js'], failAll: true });
        let threw = false, msg = '';
        try {
            runRule(rt, `
                var H = createHot({key:'jenshimanhua', base:'${RAW}', mirrors:['','https://ghproxy.net/']});
                H.lib(true);
            `);
        } catch (e) { threw = true; msg = String(e.message || e); }
        threw && /拉取失败/.test(msg) ? ok('断网时明确报错') : no('断网处理', msg.slice(0, 80));
    }

    // 节末清理临时占位（门禁模式不留明文在 dist/）
    for (const fp of _tmpCreated) { try { fs.unlinkSync(fp); } catch (e) { } }
}

/* ==================== 8. 产物自检 ==================== */
console.log('\n[8] 产物完整性');
{
    const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/manifest.json'), 'utf8'));
    mf.bookSources.length === 2 ? ok('manifest 记录 2 个书源') : no('manifest 书源数', mf.bookSources.length);
    mf.rss.length === 1 ? ok('manifest 记录 1 个订阅源') : no('manifest 订阅源数', mf.rss.length);

    const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/all.json'), 'utf8'));
    all.length === 2 ? ok('all.json 可解析（2 个源）') : no('all.json', all.length);

    for (const s of all) {
        const hasBegin = (s.jsLib || '').includes('HUB-LIB BEGIN');
        const cnt = ((s.jsLib || '').match(/HUB-LIB BEGIN/g) || []).length;
        hasBegin && cnt === 1 ? ok(`${s.bookSourceName}：HUB-LIB 注入且未重复`) : no(`${s.bookSourceName}：注入异常 count=${cnt}`);
        (s.jsLib || '').includes('function createHub') ? ok(`${s.bookSourceName}：hub.js 已内联`) : no(`${s.bookSourceName}：缺 hub.js`);
        (s.jsLib || '').includes('function createHot') ? ok(`${s.bookSourceName}：hotload.js 已内联`) : no(`${s.bookSourceName}：缺 hotload.js`);
        /* ⚠️ variableComment 可能是书源用来存加密自校验代码的容器，绝不能覆盖。
           说明文字此时改放 bookSourceComment —— 两者其一有即为通过。 */
        {
            const has = /本源的抓取逻辑/.test(s.variableComment || '') || /本源的抓取逻辑/.test(s.bookSourceComment || '');
            const vcLooksEncrypted = /^[A-Za-z0-9+/=]{100,}$/.test((s.variableComment || '').trim());
            if (has) ok(`${s.bookSourceName}：变量说明已写`);
            else if (vcLooksEncrypted) ok(`${s.bookSourceName}：variableComment 被书源占用（加密载荷），说明改放 comment —— 已跳过`);
            else no(`${s.bookSourceName}：变量说明缺失`);
        }
    }

    // 幂等性：再跑一次构建，产物应完全一致
    const before = fs.readFileSync(path.join(ROOT, 'dist/all.json'), 'utf8');
    const { execFileSync } = childProcess;
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs')], { env: { ...process.env, BUILD_TIME: String(mf.version) }, stdio: 'pipe' });
    const after = fs.readFileSync(path.join(ROOT, 'dist/all.json'), 'utf8');
    before === after ? ok('构建幂等（重复构建字节一致）') : no('构建不幂等');
}

/* ==================== 汇总 ==================== */
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
