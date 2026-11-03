# legado-hub · 订阅源驱动的书源仓库

> 目的：**代码进仓库，订阅源只负责"指路"**。
> 以后改书源逻辑 = 改仓库一个文件，装了的人下次请求自动生效，不用再挨个发订阅源。

---

## 一、它解决什么

| 旧做法（你现在的） | 这套 |
| --- | --- |
| 每个书源独立发文件，改一次要重发一次 | 仓库一份 `dist/`，谁装了都指向它 |
| 更新靠人手动导入 | 订阅源算版本差，点一下跳原生导入框 |
| 书源规则写死在 JSON 里 | 抓取逻辑放 `libs/lib-<key>.js`，**运行时热更** |
| 源一旦坏了只能等重发 | 远程代码坏了自动回滚到上一份缓存 |

---

## 二、目录

```
legado-hub/
├── config.json               ← 只改这一个：owner / repo / branch / 镜像
├── libs/                     ← 真正的"代码"
│   ├── hub.js                运行时：多镜像拉取、版本比较、缓存、深链
│   ├── panel.js              控制台 UI（菜单 + HTML 面板）
│   ├── hotload.js            书源热更新加载器（含回滚）
│   └── lib-<key>.js          每个源的远程逻辑（可留空壳，规则会兜底）
├── sources/
│   ├── src/<key>.json        ← 你的"真源码"（书源 JSON，手改这里）
│   └── meta/<key>.json       ← 元信息：名称/分组/版本/是否弃用
├── scripts/build.mjs         构建：注入 + 生成 dist + manifest
├── tools/simulate.mjs        自检：在 Node 里假装自己是阅读，跑一遍全部逻辑
└── dist/                     ← 产物，**提交进仓库**（App 只认这里）
    ├── manifest.json         清单（控制台据此算更新）
    ├── all.json              全家桶（一键全量导入）
    ├── <key>.json            单个书源
    ├── rss/console.json      控制台订阅源（给人导的）
    └── libs/lib-<key>.js     热更新代码（运行时拉这个）
```

---

## 三、三条命令

```bash
node scripts/build.mjs       # 改完源码 → 生成 dist
node scripts/build.mjs --check   # CI 里只校验不写文件
node tools/simulate.mjs      # 全量自检（41 项：拉取/降级/缓存/回滚/深链/幂等）
```

`build.mjs` 会：
1. 读 `sources/src/*.json`，把 `libs/hub.js` + `libs/hotload.js` **注入到 jsLib 顶部**（重复跑不会叠加）
2. 写 `variableComment`，让用户在源的「变量」里直接看到这段代码托管在哪
3. 生成 `dist/manifest.json`、`dist/all.json`、`dist/rss/console.json`
4. `sources/src` 为空时**直接报错退出**，不产出空清单

---

## 四、发布（建仓库后）

```bash
# 1. 改 config.json 的 owner / repo
# 2. 提交
git init && git add -A && git commit -m "init legado-hub"
git remote add origin https://github.com/<你>/<仓库>.git
git push -u origin main
```

之后发给人家的**只有一条深链**：

```
legado://import/rssSource?src=<加速前缀>https://raw.githubusercontent.com/<你>/<仓库>/main/dist/rss/console.json
```

> ⚠️ 必须在推送**之后**再构建一次（或让 CI 构建），否则 manifest 里的 sha 与线上文件不一致。

---

## 五、更新工作流

| 想改什么 | 动哪里 | 别人要做什么 |
| --- | --- | --- |
| 书源的抓取逻辑/选择器 | `libs/lib-<key>.js` | **什么都不用做**，下次请求自动生效（缓存 TTL 1 小时） |
| 书源本体字段（名字/分组/登录流程） | `sources/src/<key>.json` + 提升 `lastUpdateTime` | 控制台出现「可更新」，点一下导入 |
| 加一个新书源 | 放 `sources/src/<newkey>.json` + `sources/meta/<newkey>.json` | 控制台自动多一行 |
| 停用某个源 | `sources/meta/<key>.json` 里 `"deprecated": true` | 控制台标灰、`all.json` 不再包含 |

---

## 六、热更新怎么保证不把人搞崩

`hotload.js` 的四层保护：

1. **坏响应过滤**：拿到 HTML 错误页 / 空内容直接判失败，不交给编译器
2. **编译校验**：`new Function` 跑一遍，拿不到 `lib` 对象就算坏
3. **回滚**：新代码坏了 → 用 `hot:<key>:code` 缓存；再坏 → 用 `hot:<key>:prev` 上一份
4. **绝不静默**：全部失败时抛错，让阅读显示失败，而不是返回空列表假装没结果

---

## 七、变量安全

书源/订阅源的「变量」里**只存你自己的东西**（站点地址、密钥等），更新永远不覆盖。
`hub.js` 写入变量时走白名单（`CONFIG_KEYS`），老版遗留字段（`sourl/jk/type/seturl/key/name/page`）会被清理但**不删除用户密钥**。

---

## 八、已知限制

- 控制台的「一键导入全部」用的是 `dist/all.json`，导入框里仍要**手动选**「选中更新源」；阅读没有"静默安装"接口，这是产品边界。
- 热更新只能换**逻辑**（jsLib），换不了 `searchUrl` / `ruleToc` 这些**规则字段本身**——那类改动仍需重新导入书源。
- `trycloudflare` 之类的临时地址**不要**写进本仓库。
