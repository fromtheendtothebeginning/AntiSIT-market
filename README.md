# AntiSIT 插件市场

AntiSIT（校园服务 App）的**网页形态拓展**目录源。App 里「拓展 → 市场」这一页读的就是
本仓库的 [`market.json`](market.json)。

市场只收**能不发版就装上**的东西——也就是网页形态的拓展：

| 类型 | 说明 | 需要发版？ |
|---|---|---|
| `bundle` | 自包含的 html / js / css 压缩包（App 解压后内联成一份自包含页面） | 不需要 |
| `web` | 一个 `https` 网址（打开第三方站点，内容由站点自己控制） | 不需要 |

原生插件（主题、AI 提供商那些 Dart 包）是**编译期**的东西，装不了，市场里不会出现。

## 目录长什么样

```
ext/<id>/ext.json        ← 作者写的清单（一条拓展一个目录）
ext/<id>/index.html …    ← 网页本体（根目录放 index.html 作入口）
dist/<id>/<版本>.zip     ← 打包产物（工具生成，提交进仓库，App 从这里下载）
market.json              ← 目录（工具生成）
market.json.sig          ← 目录的 Ed25519 签名（维护者本机签）
keys/market.pub          ← 公钥（提交）；私钥 keys/market.key 只在本机、不进仓库
tool/market_tool.dart    ← 打包 / 构建 / 签名 / 校验 CLI
```

App 内置公钥，**验签通过才认目录**，每个 zip 还要对得上目录里记的 `sha256` 才会解压。
所以目录可以随便挂镜像（jsDelivr、自建 CDN 都行），镜像改不了内容。

## 市场里已经有什么

| 插件 | 是什么 | 上游 / 许可 |
|---|---|---|
| [`sit.game-2048`](ext/sit.game-2048) | 2048：滑动合数字、最高分存本机 | [gabrielecirulli/2048](https://github.com/gabrielecirulli/2048) · MIT |
| [`sit.game-minesweeper`](ext/sit.game-minesweeper) | 扫雷：10×10 二十颗雷，标记模式 / 长按插旗，**不声明任何权限**（不存数据不联网） | [kubowania/minesweeper](https://github.com/kubowania/minesweeper) · MIT |

两个游戏都是**改编版**：`ext/<id>/NOTICE.md` 写清了上游仓库、锁定的 commit 与改了哪几处
（换掉 `localStorage`、去外链字体、手机版式、中文文案等），`LICENSE` 随包一起打进 zip
——MIT 要求「随副本带上许可与版权声明」，所以它们属于要发出去的东西，不会被 `skipInZip` 跳过。

## 投一条拓展

```bash
git clone <本仓库> && cd AntiSIT-market
dart pub get

mkdir -p ext/sit.my-tool            # 目录名 = ext.json 里的 id
cp ext/_template/ext.json ext/sit.my-tool/
# 写 index.html / style.css / app.js（根目录放 index.html）

dart run tool/market_tool.dart pack  # 生成 dist/sit.my-tool/1.0.0.zip
dart run tool/market_tool.dart check # 自检（CI 也会跑，不过别等 CI）
```

然后提 PR：只改/加 `ext/<你的 id>/` 和 `dist/<你的 id>/`。
`market.json` 与 `market.json.sig` **由维护者生成提交**（签名要私钥）。

CI 会自动校验：清单字段、zip 与源是否一致、有没有危险路径、包体积、目录是否最新、签名是否有效，
还有下面两条「内置页里必然出问题」的源码体检：

> 提 PR 时 CI 会报几条「market.json 里没有它 / 目录与源不一致」——**那是正常的**：
> 目录只有维护者能签，你的 PR 只需要带 `ext/<id>/` 与 `dist/<id>/<版本>.zip`。
> 维护者合并后会跑 `dart run tool/market_tool.dart all` 重新生成并签名，这几条就消失了。
> （别自己动 `market.json`：改过又签不了名，整个目录会验签失败。）

* **不能用 `localStorage` / `sessionStorage` / `document.cookie`** —— 拓展页是 App 用
  `loadHtmlString` 打开的，来源是 opaque origin，读这些 API 直接抛 SecurityError。
  要存数据就走 `antiSIT.call("storage.get"/"storage.set")`（并在 `ext.json` 里声明 `storage`）。
* **没声明 `network` 就不能引外链资源**（`<script src=https://…>`、`url(https://…)`、`fetch(…)` …）——
  市场装的拓展默认禁网（App 注入 `connect-src 'none'` 的 CSP），引了也加载不到，插件会静默坏掉。
  普通超链接 `<a href>` 不受影响：点开会交给系统浏览器打开。

> 投稿请只收**许可明确**的代码：自己写，或者改编 MIT / Apache-2.0 这类允许再分发的项目，
> 并在包里附 `LICENSE`（许可全文）与 `NOTICE.md`（来源链接、锁定的 commit、你改了什么）。
> 没有 LICENSE、或声明「保留所有权利」的仓库不要直接搬。

## 自己发一个源（不用 PR，也不用等收录）

不想等官方目录收录、或者想自己控制更新节奏？把插件放到**你自己的仓库**里就行——
市场支持「添加第三方源」，用户粘贴你的 `所有者/仓库` 就能装。工具、格式、权限、lint
全都跟官方目录同一套，你只是自己拿着签名私钥。

```bash
# 1. 建一个空仓库，把这些拷进去（工具、格式定义、以及「别提交私钥」的 .gitignore）
#    tool/  lib/  pubspec.yaml  pubspec.lock
#    .gitattributes（锁 LF，必须）  .gitignore（挡住 keys/market.key）
#    可选：test/ + .github/（拷了的话你自己的仓库也带同一道校验，push 就跑）
dart pub get

# 2. 照官方目录一样的格式写你的插件：ext/<你的 id>/{ext.json,index.html,…}
#    id 别用 sit. 开头（那是官方目录的），用自己的前缀，例如 someone.tool

# 3. 一条龙：打包 → 生成目录（内嵌你的公钥）→ 签名 → 自检，并打印指纹
dart run tool/market_tool.dart publish
```

`publish` 第一次会顺手给你生成密钥对（`keys/market.key` 私钥、`keys/market.pub` 公钥），
然后打印**公钥指纹**与一段可以直接发出去的文案。把整个目录推到 GitHub（分支叫 `main`
最省事），再把这条发出去：

```
AntiSIT 插件源：<你的 GitHub 用户>/<仓库名>
公钥指纹：XXXX-XXXX-XXXX
```

别人在市场页「插件源 → 添加第三方源」里粘贴 `你的用户/仓库名`，App 会显示**同一串指纹**，
核对一致才添加。以后改内容：**升 `ext.json` 里的 version**，再跑一次 `publish` + push。

几条要知道的：

* **格式就是官方目录那份**（同一套 `market.json` + `.sig`，只是内嵌了你的公钥）——
  权限声明、`network` 禁网、`LICENSE`/`NOTICE` 随包、localStorage 与外链那两条体检，一样都跑。
* **换行符必须是 LF**：仓库靠 `.gitattributes` 锁 LF；`pack`/`check` 现在会直接说
  「文件里是 CRLF」，不会让它伪装成「产物与源对不上」。
* `keys/market.pub` **要提交**（`check` 拿它验签），`keys/market.key` 绝不能提交
  （拷过来的 `.gitignore` 已经挡住了）。
* **id 是全局唯一的认领**：同一个 id 只能由一个源管。已经装了官方某个拓展，第三方源拿同名
  id 想顶替会被拒——这挡住了「用别人的 id 悄悄换掉已装内容」。
* **信任模型**：目录里的公钥是**你自报**的，App 只能保证「加进来之后不被换」（换钥匙会被自动
  停用并把新旧指纹摆给用户看）。第一次是不是你，只能靠用户拿指纹和你的 README 对照——
  请把指纹写进你的 README。
* 第三方源不受官方审核约束，**内容好坏由作者和用户自己负责**（App 里会明确标成「第三方源」）。

## `ext.json` 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 小写点分，≥3 位，`^[a-z0-9][a-z0-9._-]*$`；**必须与目录名一致**；装过之后不能改（用户数据按它隔离） |
| `name` | ✓ | ≤20 字（卡片一行放得下） |
| `desc` | ✓ | ≤60 字，显示在卡片名称下方 |
| `author` | ✓ | ≤24 字 |
| `category` | ✓ | `学习` / `工具` / `生活` / `娱乐` / `其他` |
| `icon` | | 图片网址（https），或 ≤4 字的文字 / emoji；留空用名称首字 |
| `type` | ✓ | `bundle` 或 `web` |
| `version` | bundle ✓ | `x.y.z`。**改了内容必须升版本**，否则已装的用户拿不到更新 |
| `url` | web ✓ | 必须 https；bundle 不许有 |
| `permissions` | | 见下；`storage` / `network` 不声明就会被拒 |
| `minAppVersion` | | `x.y.z`，低于它的 App 显示「需要升级 App」 |
| `homepage` | | https 网址 |

### 权限

| 权限 | 什么时候要声明 |
|---|---|
| `storage` | 用到 `storage.get / set / remove`（**要**声明，安装时会告诉用户） |
| `network` | 页面运行时要联网（fetch / XHR / 远程图片）。**要**声明 |
| `theme` `toast` `close` `card` | 只跟界面有关，不声明也放行；写进 `permissions` 只是为了拦住拼写错误 |

zip 包默认**禁网**（App 注入 `connect-src 'none'` 的 CSP）：这样审核过的那份代码就是
手机上跑的那份，不会运行时再去作者服务器拉新脚本。确实要联网就声明 `network`。

App 里的用户数据（学号、课表、成绩、凭据）**不在** `antiSIT` 接口里，拓展拿不到。

## 写拓展网页

打开拓展时 App 会注入 `window.antiSIT`：

```js
const theme = await antiSIT.call('theme');       // 当前配色（跟着 App 深浅色走）
await antiSIT.call('storage.set', {key: 'n', value: 1});
antiSIT.post('toast', {text: '已保存'});          // 不需要返回值时用它
```

| 方法 | 参数 | 返回 |
|---|---|---|
| `theme` | — | 配色：`isDark / accent / bg / card / border / textPrimary / textSecondary / textMuted / danger / success` |
| `storage.get` | `{key}` | 该拓展自己存的值（任意 JSON） |
| `storage.set` | `{key, value}` | `true` |
| `storage.remove` | `{key}` | `true` |
| `toast` | `{text}` | `true` |
| `close` | — | `true`（关闭自己的页面） |
| `card.setName` / `setDesc` / `setIcon` | `{text}` | `true`（改列表里自己那张卡片） |

约定：

* 垫片在**页面加载完成后**才注入，同步脚本里 `antiSIT` 可能还不存在——轮询等它出现
  （`while (!window.antiSIT) await new Promise(r => setTimeout(r, 50))`），或者干脆不用它；
* 未知方法 / 参数不对会 **Promise reject**，消息带原因，方便调试；
* **json 包必须是自包含的**：App 会把入口页同目录的 `<link href=x.css>` 与
  `<script src=x.js>` 内联进 html（不依赖 `file://`），所以图片 / 字体这类相对路径资源
  不会内联——要么内联成 `data:`，要么别用；
* 一个 zip 最多 2 MB。超了说明这个功能不该塞进拓展。

## 维护者：签名与发版

```bash
dart run tool/market_tool.dart keygen          # 只跑一次，生成 keys/market.key + keys/market.pub
# 把 keygen 打出来的那段 kMarketPublicKeys 贴进 App 的
#   packages/plugin_ext/lib/market/market_source.dart

# 作者 PR 合并后：
dart run tool/market_tool.dart all             # pack + build + sign
git add -A && git commit -m "市场：<id> v<x.y.z>" && git push
```

`keys/market.key` **绝不提交、绝不进 CI**：CI 只有公钥，只能验签、不能签——
也就是说 CI 被攻破也伪造不出目录。私钥丢了或泄漏了，只能 `keygen --force` 换新 keyId
并发新版 App（所以 `market.pub` 是张 map，App 里能同时认识新旧两把钥匙）。

## App 侧的镜像

App 里按顺序试这几个地址，谁先返回用谁（内容都过验签，所以镜像不可信也无所谓）：

* `https://cdn.jsdelivr.net/gh/fromtheendtothebeginning/AntiSIT-market@main/`
* `https://raw.githubusercontent.com/fromtheendtothebeginning/AntiSIT-market/main/`

想加国内镜像（比如放在自己的服务器上），把 `market.json` / `market.json.sig` / `dist/**`
原样拷过去就行——不需要写接口，也不怕镜像篡改。

## 本地开发

```bash
dart pub get
dart run tool/market_tool.dart check   # 校验目录 / 产物 / 签名
dart test                              # 工具自身的单测
```
