#!/usr/bin/env node
/**
 * migrate-lib.mjs —— 把书源里的大块明文规则迁到门禁 lib（KV），书源里只留 1 行壳
 *
 * 原理：
 *   书源的 exploreUrl 本来是 `@js: var html = `...`; html;`，
 *   挪进 lib 后变成  `@js: GLIB().explore(getUrl());`
 *   真正的 13KB HTML 由门禁现场加密下发，仓库里一个字都没有。
 *
 * 用法：node scripts/migrate-lib.mjs  (在项目根跑)
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'sources', 'src');
const LIBS = path.join(ROOT, 'sources', 'libs');
fs.mkdirSync(LIBS, { recursive: true });

const FIELDS = ['exploreUrl'];   // 目前只迁这一个（无网络请求、体量大、最值得保护）

for (const f of fs.readdirSync(SRC).filter(x => x.endsWith('.json'))) {
  const key = f.replace(/\.json$/, '');
  const p = path.join(SRC, f);
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  const o = arr[0];

  const moved = {};
  for (const field of FIELDS) {
    const v = o[field];
    if (typeof v !== 'string' || v.length < 2000) continue;
    // 必须是 `@js: ... ` 且结尾是 `html;` 这类纯返回
    if (!/^@js:/.test(v)) continue;
    if (/java\.(get|ajax|connect|post)\s*\(/.test(v)) { console.log(`  ! ${key}.${field} 含网络请求，跳过`); continue; }
    moved[field] = v;
    o[field] = `@js:\nGLIB().${field === 'exploreUrl' ? 'explore' : field}(getUrl());`;
  }

  if (!Object.keys(moved).length) { console.log(`  - ${key}: 无可迁移字段`); continue; }

  fs.writeFileSync(p, JSON.stringify(arr, null, 2));

  // 生成 lib 源码
  const body = Object.entries(moved).map(([field, code]) => {
    // 去掉前缀 @js: ，只留 JS 表达式
    const js = code.replace(/^@js:\s*/, '');
    // 原代码自己可能声明了 burl，避免重复声明
    const renamed = js.replace(/\bvar burl\b/g, 'var _burl').replace(/\blet burl\b/g, 'let _burl');
    return `  ${field === 'exploreUrl' ? 'explore' : field}: function (burl) {\n${renamed.split('\n').map(l => '    ' + l).join('\n')}\n  }`;
  }).join(',\n\n');

  const libSrc = `/* lib-${key}.js —— ${key} 的远程逻辑（只存在于门禁 KV，仓库里没有）
 * 由 scripts/migrate-lib.mjs 从书源自动抽取。
 * 改这里 = 改线上逻辑，不用重新导入书源。
 */
var lib = {
${body}
};
`;
  fs.writeFileSync(path.join(LIBS, `lib-${key}.js`), libSrc);
  console.log(`  ✓ ${key}: 迁出 ${Object.keys(moved).join(',')} → sources/libs/lib-${key}.js (${libSrc.length} B)`);
}
