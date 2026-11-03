# 门禁驱动书源 · 架构与坑点

> 这份文档记录**为什么代码要这么写**。每一条都来自 Legado_Max 源码核对
> 或 Rhino 1.7.14 实测，改动前请先读。

## 一、整体链路

```
阅读 App
  │  ① 载入书源 → eval(jsLib)                    ← 此时没有 java / source
  │  ② 执行规则 → GLIB('explore', getUrl())
  │       └─ 规则作用域 chainTo(jsLib 作用域)，含 java/source
  ▼
gate.js（已内联进 jsLib）
  │  ③ 用 androidId 派生的 did 向 Worker 要密文
  │  ④ 解密得到 lib 源码（AES-256-CBC，每设备一把密钥）
  │  ⑤ 在「还原了 jsLib 上下文」的作用域里 eval 源码
  │       ├─ jsLib 里的 getUrl() / cache / source 全部可用
  │       └─ 语义与直接把代码写在书源里完全一致
  ▼
Cloudflare Worker（legado-gate）
```

lib 源码只存在于 Cloudflare KV，仓库里一份都没有。

## 二、Rhino 的五个硬约束（全部实测）

| # | 现象 | 结论 |
|---|---|---|
| 1 | jsLib 求值时 `source` 未定义 | **顶层绝不能引用 java/source** |
| 2 | jsLib 函数内裸写 `source` → ReferenceError | 只能走 `this.source` |
| 3 | jsLib 函数内调另一个 jsLib 函数，`this` 退化成 Java 包对象 | 必须显式传 this |
| 4 | `new Function` 建在全局作用域 | 看不到 jsLib / java / source |
| 5 | 无 `Proxy` | 无法自动代理，只能手工建 shim |

对应实现：`libs/gate.js` 的 `buildCtx()` + `run()`，以及 `scripts/build.mjs`
里 `GDPKG()` 的懒初始化（用 `this` 取上下文并缓存）。

## 三、bookSource 的三个隐藏陷阱

### 1. 内置三重 MD5 自校验

部分书源会校验自身字段：

```js
let a = java['md5Encode'](source.searchUrl);   // 必须 = 6500c80f...
let b = java['md5Encode'](source.jsLib);       // 必须 = 046594765d...
let c = java['md5Encode'](source.exploreUrl);  // 必须 = 472c12ee...
if (任一对不上) throw new Error("校验失败");
```

**任何注入都会让它失效**。`scripts/selfcal.mjs` 会在注入后重算并写回。
校验逻辑本身存在 `variableComment` 里（AES-ECB 加密），不在被校验字段内，
所以可以安全重写。

### 2. variableComment 是加密载荷容器

`getUrl()` 的实现：

```js
function getUrl() {
  var vc = this.source['variableComment'];
  var pt = this.java['aesBase64DecodeToString'](vc, getSecretKey(), 'AES/ECB/PKCS7Padding', '');
  return eval(pt);   // 解出来就是真实站点地址
}
```

**绝对不能在 variableComment 里塞说明文字**，否则解密直接失败。
build.mjs 已加保护：有值就不动它，说明改放 `bookSourceComment`。

### 3. bookSourceUrl 是诱饵

`"❗❗你猜👻🔐"` 这类值不是 URL，是作者的防抄袭标记。别改。

## 四、安全模型（v3）

### 已废弃：客户端持共享密钥

早期版本在书源里放 `kidSecret` 做 HMAC 签名。**这是错的**：

- 书源公开分发 → 密钥必然泄露
- 泄露后能伪造**任意 uid**，冒充别人设备，比没有密钥更糟

### 现行：设备身份 + 每设备密钥

- 身份：`did = md5('legado-gate|' + androidId)`（不直接外发 androidId）
- 下发：`ek = HKDF(master, 'lib|did|kid')`，每设备密文不同
- 管控：`/admin/ban {did}` 精确封禁；`/admin/revoke` 强制全量刷新
- 限流：每设备每小时 30 次（可配 `RATE_LIMIT`）
- 时间窗：`ts` 超出 ±10 分钟拒绝

### 能力边界（务必对外说明）

JS 明文在设备上执行，**不存在绝对不可破解**。这套方案能做到：

- ✅ 仓库里没有受保护的逻辑
- ✅ 网络上看不到明文，且每人密文不同
- ✅ 泄露可追溯到具体设备
- ✅ 可远程下架 / 封禁 / 强制更新
- ❌ 不能阻止已拿到源码的人在**自己设备上**窥看

## 五、测试

```bash
node scripts/build.mjs        # 构建（含自校验值自校准）
node tools/worker-test.mjs    # Worker 单元测试（20 项）
node tools/gate-test.mjs      # 门禁闭环（12 项，含上下文还原验证）
node tools/simulate.mjs       # 全流程模拟（41 项）
node tools/rhino-test.mjs     # 真 Rhino 引擎端到端（需 java 11+）
```

`rhino-test` 会把 build 出来的 jsLib 丢进真实的 Rhino 1.7.14，
复刻 Legado 的两段式作用域——**这是唯一能提前发现「上线即崩」的手段**。
