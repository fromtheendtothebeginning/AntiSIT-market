# 来源与改动说明（扫雷）

* 上游：[kubowania/minesweeper](https://github.com/kubowania/minesweeper)
  （Ania Kubow 的「Minesweeper using the Recursion Algorithm」教学实现）
* 版本：`master` 分支，commit `a88b0eb0f9da16836dd551ff8cee0a2bdaffef7c`（2026-10-18 取）
* 许可：MIT，Copyright (c) 2020 Ania Kubow。
  上游仓库里**没有单独的 LICENSE 文件**，许可声明写在 README 的「MIT Licence」一节；
  同目录 [`LICENSE`](LICENSE) 就是照那一节抄的完整正文。
* 本包是**改编版**，不是上游原样副本。

## 改了什么

1. **修了邻格统计的边界 bug**：上游用写死的常量判断边界
   （`i > 9` / `i > 10` / `i > 11` / `i < 88` / `i < 89` / `i < 90` / `i < 98`，按 10 列手工推出来的），
   在若干位置会漏算邻格——比如 `i = 10`（第二行第一格）漏掉正上方的雷、`i = 11` 漏掉左上角、
   `i = 89` 漏掉正下方，于是**格子上的数字会与真实雷数不一致**。这里改成按行列算的
   `neighbours(index)`，数字与雷的分布严格一致。
2. **翻开的递归展开**同样改用 `neighbours()`（上游是同一套写死常量），保留上游 10ms 逐步展开的观感。
3. **触屏操作**：上游只有「左键翻开 + 右键插旗」，手机上等于没法插旗。加了
   「🚩 标记」开关（开了之后点击即插旗）与**长按 450ms 插旗**；鼠标右键照旧可用。
   同时给棋盘加了 `-webkit-touch-callout: none` / `user-select: none`，免得长按弹出系统菜单或选中文字。
4. **胜负判定**：上游只在「旗子插满所有雷」时判赢。保留这条，同时补上通行规则——
   **所有非雷格子都翻开也算赢**（不然清完场还得靠插旗收尾）。赢的时候报用时。
5. **样式重写**（`style.css`）：上游是 400px 固定棋盘 + flex 换行 + 每格写死 40px，
   改成 `display: grid` + `width: min(94vw, 430px)` + `aspect-ratio: 1`，棋盘随屏宽缩放、
   格子恒为正方形；配色沿用上游的复古描边，数字补到 8 种颜色（上游只给了 1~4，
   而 10×10 二十颗雷很容易出 5 以上）。
6. **去外链**：上游 `index.html` 引了 Google Fonts 的 Roboto Mono（市场装的拓展默认禁网，
   会被 CSP 拦掉），改用系统字体栈；另补 `<meta name="viewport">` 与 `lang="zh-CN"`。
7. **新增**：计时器、重来按钮、剩余雷数/用时状态栏、中文文案。
   `ext.json` 的 `permissions` 为**空**——这个插件不存任何数据、也不联网
   （正好当「不需要敏感权限的插件」的样例）。

## 保留

棋盘尺寸（10×10 / 20 颗雷）、随机撒雷的洗牌写法、以「格子 div + class 标记状态」为核心的
结构、`data` 属性存雷数、`flag` / `checked` / `bomb` 的类名，都与上游一致。
