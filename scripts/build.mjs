#!/usr/bin/env node
/**
 * build.mjs —— 从 sources/src + libs 生成 dist/（阅读 App 直接抓取的那份）
 *
 * 设计要点：
 *   · sources/src/<key>.json  是你的"真源码"，可以直接编辑
 *   · dist/ 是产物，**提交进仓库**（App 只认 dist 里的文件）
 *   · 每个书源写入时自动注入 HUB-LIB 区块（hub.js + hotload.js），并重复注入不会叠加
 *   · 同时生成 out/manifest.json（控制台读它算更新）、all.json（一键全量）
 *
 * 用法：
 *   node scripts/build.mjs           # 生成
 *   node scripts/build.mjs --check   # 只校验，不写文件（CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { selfCalibrate } from './selfcal.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const CHECK_ONLY = process.argv.includes('--check');
const BUILD_TIME = Number(process.env.BUILD_TIME || CFG.buildTime || Date.now());

const RAW_BASE = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/`;
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'sources', 'src');
const META = path.join(ROOT, 'sources', 'meta');
const LIBS = path.join(ROOT, 'libs');

const BEGIN = '/* ==== HUB-LIB BEGIN (由 build.mjs 生成，勿手改) ==== */';
const END = '/* ==== HUB-LIB END ==== */';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const listJson = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];

if (!fs.existsSync(SRC) || listJson(SRC).length === 0) {
  console.error('✗ sources/src 为空：先放入 <key>.json，否则清单里不会有任何书源');
  process.exit(2);
}

let problems = [];
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { problems.push(m); console.log('  ✗ ' + m); };

/* ---------------------------------------------------------------- 1. 读库 */
const hubJs = read(path.join(LIBS, 'hub.js'));
const hotJs = read(path.join(LIBS, 'hotload.js'));
const panelJs = fs.existsSync(path.join(LIBS, 'panel.js')) ? read(path.join(LIBS, 'panel.js')) : '';
const gateJs = fs.existsSync(path.join(LIBS, 'gate.js')) ? read(path.join(LIBS, 'gate.js')) : '';
const GATE = CFG.gate || {};
// 只有配了门禁地址才注入；没配就保持纯热更新模式（不至于把源弄挂）
const GATE_ON = !!(GATE.url && gateJs);
const GATE_URLS = (() => {
  const u = GATE.url, f = GATE.fallback;
  const arr = Array.isArray(u) ? u.slice() : (u ? [u] : []);
  if (f) (Array.isArray(f) ? f : [f]).forEach((x) => { if (x && arr.indexOf(x) < 0) arr.push(x); });
  return arr;
})();

/* --------------------------------------------------- 2. 处理器：注入 HUB 区块 */
function injectHublib(jsLib, key) {
    // 先剥掉旧区块，保证幂等
    let lib = jsLib || '';
    const b = lib.indexOf(BEGIN), e = lib.indexOf(END);
    if (b >= 0 && e > b) lib = lib.slice(0, b) + lib.slice(e + END.length);

    const header = [
        BEGIN,
        `/* 本块由 build.mjs 生成。想改请改仓库 libs/ 下的源文件，然后重跑构建。 */`,
        hubJs,
        hotJs,
        `/* --- 该源的远程逻辑入口（C 档热更新：改仓库 libs/lib-${key}.js 即可生效） --- */`,
        `var HSRC = { key: ${JSON.stringify(key)}, base: ${JSON.stringify(RAW_BASE)}, mirrors: ${JSON.stringify(CFG.mirrors)} };`,
        `var HOT = createHot({ key: HSRC.key, base: HSRC.base, mirrors: HSRC.mirrors, lib: 'dist/libs/lib-${key}.js' });`,
        `/* 拿到远程逻辑对象；失败时返回 null，规则里要自己判空并走本地兜底 */`,
        `function hotLib() { try { return HOT.lib(false); } catch (e) { try { java.log('hotLib 不可用: ' + e); } catch (e2) { } return null; } }`,
        ...(GATE_ON ? [
          gateJs,
          `/* --- 门禁 ------------------------------------------------------------`,
          ` * 注意：jsLib 求值时没有 java / source，所以这里绝不能直接 createGate(java, source)。`,
          ` * 改为首次被调用时用 this 取上下文并缓存（Legado 的规则作用域链着 jsLib，`,
          ` * this 能拿到 bindings 里的 java/source）。已用 Rhino 1.7.14 实测。`,
          ` * ------------------------------------------------------------------ */`,
          `var GATE_CFG = {`,
          `  urls: ${JSON.stringify(GATE_URLS)},`,
          `  kid: ${JSON.stringify(key)}`,
          `};`,
          `var _GATE = null, _GCTX = null;`,
          `function GDPKG() {`,
          `  /* 源配置可能变（用户换站点），变了就重建 */`,
          `  var origin = '';`,
          `  try { origin = String((source && source.bookSourceUrl) || ''); } catch (e) { }`,
          `  if (_GATE && _GCTX && _GCTX.origin === origin) return _GATE;`,
          `  var j = this.java || (_GCTX && _GCTX.java);`,
          `  var s = this.source || (_GCTX && _GCTX.source);`,
          `  if (!j || !s) throw new Error('门禁初始化失败：拿不到 java/source（请更新书源）');`,
          `  _GCTX = { java: j, source: s, origin: origin };`,
          `  var c = {}; for (var k in GATE_CFG) c[k] = GATE_CFG[k];`,
          `  c.origin = origin;`,
          `  _GATE = createGate(j, s, c);`,
          `  return _GATE;`,
          `}`,
          `/* 规则里统一用 GLIB('方法名', ...参数) 调用远程逻辑；`,
          `   门禁失败会抛错，绝不静默降级到本地明文。 */`,
          `function GLIB(name) {`,
          `  var g = GDPKG.call(this);`,
          `  var args = Array.prototype.slice.call(arguments, 1);`,
          `  return g.run(this, g.code(), name, args);`,
          `}`,
          `/* 不传方法名：执行源码并返回最后一个表达式（兼容老写法） */`,
          `function GEVAL() { var g = GDPKG.call(this); return g.run(this, g.code()); }`,
          `function GINFO() { return GDPKG.call(this).info(); }`,
        ] : []),
        END
    ].join('\n');

    return header + '\n' + lib.replace(/^\s+/, '');
}

/* --------------------------------------------------- 3. 处理每个书源 */
const sources = [];
const allSources = [];
for (const f of listJson(SRC)) {
    const key = f.replace(/\.json$/, '');
    const raw = read(path.join(SRC, f));
    let arr;
    try { arr = JSON.parse(raw); } catch (e) { bad(`${key}: JSON 解析失败 ${e.message}`); continue; }
    if (!Array.isArray(arr)) arr = [arr];
    if (!arr.length) { bad(`${key}: 空数组`); continue; }

    const metaPath = path.join(META, `${key}.json`);
    const meta = fs.existsSync(metaPath) ? JSON.parse(read(metaPath)) : {};

    const withLib = arr.map((s) => {
        const o = Object.assign({}, s);
        o.jsLib = injectHublib(o.jsLib, key);

        /* ⚠️ variableComment 绝对不能覆盖！
           本站书源把它当成「加密的自校验代码」容器，getUrl() 会做
           AES 解密后 eval —— 混入任何说明文字都会让解密直接失败。
           说明文字改放 bookSourceComment。 */
        const keepVC = !!o.variableComment && String(o.variableComment).trim().length > 0;
        const note = [
            '本源的抓取逻辑在仓库里热更新（改代码不用重导）。',
            `仓库：${CFG.owner}/${CFG.repo}`
        ].join(' ');
        if (!keepVC) o.variableComment = [note, meta.variableComment || ''].filter(Boolean).join('\n');
        else if (meta.variableComment) o.bookSourceComment = [o.bookSourceComment, meta.variableComment].filter(Boolean).join('\n');
        return o;
    });

    /* 书源若内置了三重 MD5 自校验（md5(searchUrl)/md5(jsLib)/md5(exploreUrl)），
       注入库与替换 exploreUrl 会让它失效 —— 这里按最终字段重算并写回。 */
    if (CFG.selfcal && CFG.selfcal.key) {
        for (const o of withLib) {
            const r = selfCalibrate(o, CFG.selfcal.key);
            if (r.ok && r.changed) ok(`${key}: 自校验值已校准（${Object.keys(r.after).filter(k=>r.before[k]!==r.after[k]).join(',')}）`);
            else if (!r.ok && !r.skipped) ok(`${key}: 自校准跳过（${r.reason || '无内置校验'}）`);
        }
    }

    const body = JSON.stringify(withLib, null, 2);
    const first = withLib[0];
    const info = {
        key,
        name: meta.name || first.bookSourceName,
        group: meta.group || first.bookSourceGroup || '',
        type: first.bookSourceType === undefined ? 0 : first.bookSourceType,
        enabled: meta.enabled === undefined ? (first.enabled !== false) : meta.enabled,
        desc: meta.desc || '',
        deprecated: !!meta.deprecated,
        version: meta.version || String(first.lastUpdateTime || 0),
        lastUpdateTime: first.lastUpdateTime || 0,
        file: `dist/${key}.json`,
        sha256: sha(body),
        hot: fs.existsSync(path.join(ROOT, 'libs', `lib-${key}.js`)),
        gated: GATE_ON
    };
    sources.push(info);
    allSources.push(...withLib);

    if (!CHECK_ONLY) {
        fs.mkdirSync(DIST, { recursive: true });
        fs.writeFileSync(path.join(DIST, `${key}.json`), body);
    }
    ok(`${key} · ${info.name} · v${info.version} · ${(body.length / 1024).toFixed(1)} KB · hot=${info.hot}`);
}

/* --------------------------------------------------- 4. 订阅源（控制台） */
const rssList = [];
if (panelJs) {
    const consoleCfg = CFG.console || {};
    const jsLib = [
        hubJs, panelJs,
        `var HSRC = { base: ${JSON.stringify(RAW_BASE)}, mirrors: ${JSON.stringify(CFG.mirrors)} };`,
        `function hubInst() { return createHub(java, source, { mirrors: HSRC.mirrors, cacheTTL: ${CFG.cacheTTL || 21600} }); }`,
        `function panelInst() { return buildPanel(hubInst(), { base: HSRC.base, tag: ${JSON.stringify(consoleCfg.tag || '辞晨')}, consoleRss: 'dist/rss/console.json' }); }`
    ].join('\n');

    const rss = {
        articleStyle: 1,
        cacheFirst: false,
        customOrder: -10100179,
        enableJs: true,
        enabled: true,
        enabledCookieJar: true,
        header: '',
        jsLib,
        lastUpdateTime: 0,                       // 构建时覆盖
        loadWithBaseUrl: false,
        preload: false,
        ruleArticles: '@js:\nvar p = panelInst();\nvar list = p.menu();\nlist',
        ruleContent: '<js>\nvar p = panelInst();\nresult = p.html(rssArticle);\nresult',
        ruleImage: 'img',
        ruleLink: 'url',
        ruleTitle: 'name',
        searchUrl: consoleCfg.searchUrl || 'data:;base64,辞晨控制台,{"hub":2}',
        singleUrl: false,
        sortUrl: consoleCfg.sortUrl || '',
        sourceComment: '书源控制台：所有书源/订阅源都在这里，点按钮即导入。代码托管在 GitHub，更新不用再发订阅源。',
        sourceGroup: consoleCfg.group || '管理,写源',
        sourceIcon: consoleCfg.icon || 'https://t.alcy.cc/ysz',
        sourceName: consoleCfg.name || '🌐 书源控制台',
        sourceUrl: consoleCfg.url || 'data:;base64,辞晨中心,{"hub":2}',
        type: 0,
        variableComment: '这个订阅源是"遥控器"，本身不带内容。\n它读仓库里的 manifest.json 算出版本与更新，点条目直接拉起阅读的导入框。\n变量里可以改镜像顺序（mirror），一般不用动。'
    };

    rss.lastUpdateTime = BUILD_TIME;
    const body = JSON.stringify([rss], null, 2);
    rssList.push({
        key: 'console',
        name: rss.sourceName,
        version: String(rss.lastUpdateTime),
        desc: '书源/订阅源总控面板',
        file: 'dist/rss/console.json',
        sha256: sha(body)
    });
    if (!CHECK_ONLY) {
        fs.mkdirSync(path.join(DIST, 'rss'), { recursive: true });
        fs.writeFileSync(path.join(DIST, 'rss', 'console.json'), body);
    }
    ok(`rss/console.json · ${rss.sourceName} · ${(body.length / 1024).toFixed(1)} KB`);
}

/* --------------------------------------------------- 5. 清单 */
const manifest = {
    schema: 2,
    version: String(BUILD_TIME),
    updated: new Date(Number(BUILD_TIME)).toISOString().replace('T', ' ').slice(0, 19),
    rawBase: RAW_BASE,
    mirrors: CFG.mirrors,
    bundle: 'dist/all.json',
    bookSources: sources,
    rss: rssList
};

const allBody = JSON.stringify(allSources, null, 2);
manifest.bundleSha = sha(allBody);

if (!CHECK_ONLY) {
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(DIST, 'all.json'), allBody);

    // ⚠️ 门禁模式下 lib 绝不能落进 dist/ —— 那等于把受保护的逻辑直接公开
    // 只有未配门禁时才发布明文 lib（纯热更新模式）
    const SRC_LIBS = path.join(ROOT, 'sources', 'libs');   // 门禁 lib 源（不进 dist）
    if (!GATE_ON) {
        fs.mkdirSync(path.join(DIST, 'libs'), { recursive: true });
        for (const f of fs.readdirSync(LIBS).filter((x) => /^lib-.*\.js$/.test(x))) {
            fs.copyFileSync(path.join(LIBS, f), path.join(DIST, 'libs', f));
            ok(`libs/${f} 已发布（未启用门禁）`);
        }
        for (const s of sources) {
            const target = path.join(DIST, 'libs', `lib-${s.key}.js`);
            if (!fs.existsSync(target)) {
                fs.writeFileSync(target, placeholderLib(s.key));
                ok(`libs/lib-${s.key}.js 已生成占位`);
            }
        }
    } else {
        // 门禁模式：清理历史残留的明文 lib，避免误提交
        const distLibs = path.join(DIST, 'libs');
        if (fs.existsSync(distLibs)) {
            for (const f of fs.readdirSync(distLibs).filter((x) => /^lib-.*\.js$/.test(x))) {
                fs.unlinkSync(path.join(distLibs, f));
                ok(`已移除 dist/libs/${f}（门禁模式下不发布明文）`);
            }
        }
        if (fs.existsSync(SRC_LIBS)) {
            const gated = fs.readdirSync(SRC_LIBS).filter((x) => /^lib-.*\.js$/.test(x));
            for (const f of gated) {
                const kid = f.replace(/^lib-/, '').replace(/\.js$/, '');
                ok(`门禁 lib：${kid} → 请用 tools/gate-push.sh 上传到 Worker`);
            }
        }
    }
}

/* --------------------------------------------------- 6. 汇总 */
console.log('\n清单：' + sources.length + ' 书源 / ' + rssList.length + ' 订阅源');
if (problems.length) {
    console.error('\n✗ 有 ' + problems.length + ' 个问题：');
    problems.forEach((p) => console.error('   - ' + p));
    process.exitCode = 1;
} else {
    console.log('✓ 构建通过');
}

function placeholderLib(key) {
    return `/* dist/libs/lib-${key}.js —— 该源的远程逻辑（热更新用）
 * 约定：整个文件跑完要给全局 lib 赋一个对象，方法名随意，规则里用 HOT.lib().xxx() 调。
 * 现在还是空壳：规则会走书源本体的 jsLib 兜底，不影响使用。
 * 想接管某个阶段时，在这里实现 search/explore/bookInfo/toc/content 之一即可。
 */
var lib = {};
`;
}
