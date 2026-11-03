#!/usr/bin/env node
/**
 * selfcal.mjs —— 书源自校验值自校准
 * ---------------------------------------------------------------------------
 * 部分书源会校验自身三个字段的 MD5（防篡改）：
 *     md5(searchUrl) / md5(jsLib) / md5(exploreUrl)
 * 一旦 build.mjs 往 jsLib 注入门禁代码、或把 exploreUrl 换成壳，这三个值必然变，
 * 书源就会在运行时直接抛「校验失败」。
 *
 * 校验逻辑本身保存在 source.variableComment 里（AES-ECB 加密），
 * 它**不在**被校验的字段内 —— 所以可以：改字段 → 重算 MD5 → 重写回 variableComment。
 *
 * 只有在 config.json 里显式给出 selfcal.key 时才运行，否则自动跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function selfCalibrate(sourceObj, key, override) {
  override = override || {};
  if (!key) return { skipped: true };

  const vc = sourceObj.variableComment || '';
  if (!vc) return { skipped: true, reason: 'no variableComment' };

  let plain;
  try {
    const d = crypto.createDecipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
    plain = Buffer.concat([d.update(Buffer.from(vc, 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return { skipped: true, reason: 'decrypt failed: ' + e.message };
  }

  // 找出校验段里的三个常量
  const re = /let\s+a\s*=\s*java\[['"]md5Encode['"]\]\(source\.searchUrl\);[\s\S]{0,400}?if\s*\(([^)]*)\)/;
  const m = plain.match(re);
  if (!m) return { skipped: true, reason: '未发现内置校验段' };

  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

  /* ⚠️ 关键：jsLib 的校验值必须按**用户实际持有的最终 jsLib** 算，
     而注入代码会在后面改掉它。所以这里要求调用方传入「已定稿的 jsLib」，
     没传就退回对象当前的 jsLib。

     更麻烦的是：书源在 jsLib 求值过程中就会自检一次，那时的 source.jsLib
     已经是完整内容；之后再求值也是同一份。只要自检用同一份最终内容，
     校验值就是稳定的。 */
  const finalJsLib = override.jsLib !== undefined ? override.jsLib : (sourceObj.jsLib || '');
  const finalExplore = override.exploreUrl !== undefined ? override.exploreUrl : (sourceObj.exploreUrl || '');

  const want = {
    searchUrl: md5(sourceObj.searchUrl || ''),
    jsLib: md5(finalJsLib),
    exploreUrl: md5(finalExplore),
  };
  const found = [...m[1].matchAll(/["']([0-9a-f]{32})["']/g)].map((x) => x[1]);

  // 依出现顺序对应 a(searchUrl) / b(jsLib) / c(exploreUrl)
  const order = ['searchUrl', 'jsLib', 'exploreUrl'];
  if (found.length < 3) return { skipped: true, reason: '校验常量不足 3 个' };

  const mapping = { searchUrl: found[0], jsLib: found[1], exploreUrl: found[2] };
  let changed = false, rewritten = plain;
  for (const k of order) {
    if (mapping[k] !== want[k]) {
      rewritten = rewritten.split(mapping[k]).join(want[k]);
      changed = true;
    }
  }
  if (!changed) return { ok: true, changed: false };

  const e = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  const newVc = Buffer.concat([e.update(Buffer.from(rewritten, 'utf8')), e.final()]).toString('base64');
  sourceObj.variableComment = newVc;
  return { ok: true, changed: true, before: mapping, after: want };
}
