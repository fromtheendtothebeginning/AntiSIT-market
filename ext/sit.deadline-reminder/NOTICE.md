# NOTICE

**截止提醒（`sit.deadline-reminder`）**

* 版权所有 (C) 2026 AntiSIT contributors
* 许可：GNU General Public License v3.0 only（全文见同目录 `LICENSE`）

## 来源

本项目是原创实现，没有复制任何第三方代码。功能范围只有两件事：

1. 在本机维护一份作业 / 考试的截止时间清单，按截止时间陈列未完成项；
2. 按用户选择的提前量，预约 App 的本地定时通知。

## 数据与隐私

* 所有条目存在拓展自己的 `ctx.storage` 里，不写文件、不联网；
* 「粘贴导入」只解析用户主动粘贴到文本框里的文字，解析在本地完成；
* 不读取、不保存任何学习通 / 雨课堂账号、Cookie 或 Token；
* 本拓展不使用 `ctx.secrets`，也不调用 `ctx.net.request`。

## 第三方组件

无。界面使用 App 注入的 CSS 变量取配色；图标由 App 按 `line:event` 渲染。
