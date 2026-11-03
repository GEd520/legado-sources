# 门禁方案（L3 + L4）

## 数据流

```
① 阅读 App 里只有 30 行 guard
   uid = java.androidId()                        ← 设备标识
        │
② GET  {GATE}/k?kid=<书源key>
   headers: X-Uid: uid, X-Sig: HMacHex(path+ts+uid, KID_SECRET)
        │                                    （KID_SECRET 在 guard 里，只是防"裸调"，
        │                                     真保护在服务端，因为它能伪造但拿不到 key）
        ▼
③ Cloudflare Worker
   · uid 是否合法格式 / 是否在黑名单
   · 吊销名单检查
   · 返回 AES 密文 k（用 HKDF(master, uid) 派生的密钥加密）
   · 顺带下发 sigs[]（防重放）
        │
④ App: java.createSymmetricCrypto('AES/CBC/PKCS5Padding', ek, iv).decryptStr(k)
        │
⑤ 用 k 解 lib.ts（AES 密文）→ new Function 执行
        │
⑥ 后续每个请求带 sig = HMacHex(path, k)，Worker 验签 + 限速
```

## 关键点：**k 永远不出现在书源里**

`k` 是"每个 uid 一把"的运行密钥，必须向 Worker 换。所以：
- 公开分发书源 → 别人拿到的是 30 行壳 + `lib.ts` 密文
- 想解密 `lib.ts` → 必须先过 Worker → Worker 认 uid、能拉黑、能限速
- 你把某人的 uid 拉黑 → 他下次换不到 k → 源立刻失效（**不用重新分发**）

## 成本

Cloudflare Worker 免费额度：**10 万次/天**。按一人一天 200 次算，够 500 人。
KV 免费额度 1000 写/天、10 万读/天，够存几千个 uid。

## 部署三步（需要你操作的那部分）

1. `npm i -g wrangler`（或 `npx wrangler`），`wrangler login`
2. 在 `worker/` 里 `wrangler kv namespace create GATE` → 把返回的 id 填进 `wrangler.toml`
3. `wrangler secret put MASTER_SECRET` + `wrangler secret put ADMIN_TOKEN`，然后 `wrangler deploy`

我这边会把 Worker 代码、guard 的 JS、本地加解密工具、密钥轮换脚本全部写好并自测。

---

## ⚠️ 为什么有 Pages 代理层（重要）

`*.workers.dev` 在**中国大陆网络下会被 TLS SNI 层阻断**（不是 DNS，也不是代理问题）：

```
对同一个 Cloudflare IP 104.21.67.47 做 TLS 握手：
  SNI = legado-gate.ged520.workers.dev   → ECONNRESET   ❌
  SNI = example.pages.dev                → TLSv1.3 OK   ✅
  SNI = www.cloudflare.com               → TLSv1.3 OK   ✅
```

实测结论：**只封 `workers.dev` 这一个后缀**，`pages.dev` / `r2.dev` 全部正常。

所以门禁前面套了一层 **Cloudflare Pages 反代**（免费、不限个数、不用自己的域名）：

```
阅读 App
   │  https://legado-gate-proxy.pages.dev/k?kid=...
   ▼
Pages Function（纯透传，只白名单 /ping /k /admin/*）
   │  https://legado-gate.ged520.workers.dev/k?kid=...
   ▼
Worker（真正的鉴权 + 解密下发）
```

- 前端地址：`https://legado-gate-proxy.pages.dev`
- 上游地址：`https://legado-gate.ged520.workers.dev`（只当后端用，客户端**不再直连**）
- 代理源码：`proxy/dist/_worker.js`
- 部署：`cd proxy && npx wrangler pages deploy dist --project-name=legado-gate-proxy --branch=main`

**代理是纯透传，不碰密钥与加解密**：`X-Uid` / `X-Sig` / `Authorization` 原样转发，
所以安全性完全由 Worker 决定，加一层不降低强度。

### 以后有了自己的域名

`config.json` 里 `gate.fallback` 保留了 workers.dev 原地址。等域名托管进 Cloudflare 并 Active 后，
可以直接把 Custom Domain 绑到 Worker 上，然后改 `gate.url` 即可，**代理层可留可删**。

### 部署后必做

Cloudflare 会按 User-Agent 拦 `Python-urllib`（报 `error code: 1010`）。
`tools/gate-push.sh` 已内置 `User-Agent: curl/8.5.0`，自己写脚本上传时也要带上 UA。
