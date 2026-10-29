# 来源与改动说明（2048）

* 上游：[gabrielecirulli/2048](https://github.com/gabrielecirulli/2048)
* 版本：`master` 分支，commit `478b6ec346e3787f589e4af751378d06ded4cbbc`（2026-10-18 取）
* 许可：MIT（见同目录 [`LICENSE.txt`](LICENSE.txt)，Copyright (c) 2014 Gabriele Cirulli）
* 本包是**改编版**，不是上游原样副本。

## 改了什么

1. **存储层换成 App 的接口**（上游 `js/local_storage_manager.js` → 本包 `js/ext_storage_manager.js`）：
   拓展页是 App 用 `loadHtmlString` 打开的，来源是 opaque origin，读 `window.localStorage`
   直接抛 SecurityError。上游虽有 try/catch 会退回内存版（游戏仍能开），但最高分关掉 App
   就没了。现在最高分走 `antiSIT.call('storage.get'/'storage.set')` 真正落盘，
   所以 `ext.json` 里声明了 `storage` 权限。顺带去掉「继续上局」那套棋局落盘
   （`getGameState()` 固定返回 null），每次打开都是新一局。
2. **手机版式**：上游是两套写死的版式（桌面 500px、≤520px 时 280px），改为按屏宽缩放
   （`min(440px, 88vw)`，几何比例与上游一致）。改动全部集中在 `style/main.css` 末尾的
   `@media (max-width: 560px)` 段落，上游原有规则未删。
3. **去掉外链与包外资源**：删掉 `@import url(fonts/clear-sans.css)`（7 个字体文件，改用系统
   字体栈）、`favicon.ico` 与 `meta/apple-touch-*.png` 的 `<link>`（App 里用不到）。
   市场装的拓展默认禁网，带这些外链会被 CSP 拦掉，也会被市场工具拦在投稿这一步。
4. **文案**：界面文案与游戏提示改为中文（`得分`/`最高`/`新游戏`/`你赢了！`/`游戏结束` 等），
   说明文字改成「滑动或方向键」。滑动手势是**上游自带**的
   （`js/keyboard_input_manager.js` 里 touchend 的手势识别），没有改动。
5. `index.html` 补了 `<meta name="viewport">`、`lang="zh-CN"`；底部的「官方版声明」换成
   指向上游仓库的署名（点开由系统浏览器打开，见 `docs/extensions.md` 的导航约定）。
6. **撤回**：`game_manager.js` 在每次有效移动前压一份棋盘快照（`serialize()`，最多 20 步，
   只在内存里；新开一局清空），`undo-button` 弹栈恢复棋盘、分数与胜负状态，并收掉
   「游戏结束 / 你赢了」浮层——所以踩死之后也能撤回。`html_actuator.js` 按有无历史
   给按钮压灰/恢复，`keyboard_input_manager.js` 绑了按钮和 Z / Ctrl+Z 快捷键，
   `index.html` / `style/main.css` 加了按钮与样式。

## 未改动

`js/grid.js`、`js/tile.js`、`js/ext_storage_manager.js`、三个 polyfill 与 `style/main.css`
除上述之外的规则，都与上游一致（`js/html_actuator.js` 仅按第 4、6 条改文案与撤回按钮状态）。
