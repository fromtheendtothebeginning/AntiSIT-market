# NOTICE

**学习通截止提醒（`sit.deadline-reminder`）**

* 版权所有 (C) 2026 AntiSIT contributors
* 许可：GNU General Public License v3.0 only（全文见同目录 `LICENSE`）

## 来源

本项目是原创实现，没有复制任何第三方代码。功能范围只有两件事：

1. 在本机维护一份作业 / 考试的截止时间清单，按截止时间陈列未完成项；
2. 按用户选择的提前量，预约 App 的本地定时通知。

## 数据与隐私

* 条目存在拓展自己的 `ctx.storage` 里；「粘贴导入」只解析用户主动粘贴的文字。
* 选择「从剪贴板导入 Cookie」时，拓展通过 `ctx.clipboard.read` 读取剪贴板（App 会弹窗确认），
  把 Cookie 存进 `ctx.secrets`（系统加密存储，按拓展隔离）。
* 同步时通过 `ctx.net.request` 访问学习通的课程 / 作业 / 考试列表；**没有提交作业、签到、
  答题、改分这类写接口**。每个新域名第一次访问会由 App 弹窗确认，拒绝即停止。
* 不读取、不保存学习通 / 雨课堂账号密码。
* 可选「后台刷新」：开启后 App 启动一个前台服务并显示常驻通知，让**本拓展页**
  在退到后台后继续跑定时器；不执行隐藏页面。关掉拓展页即停止。
* 可选「弹窗通知」：通过 `ctx.permissions.request('notification.popup')` 申请高优先级
  横幅通知；用户可在拓展「权限」里随时关闭，关闭后回到普通通知。

## 第三方组件

无。界面使用 App 注入的 CSS 变量取配色；图标由 App 按 `line:event` 渲染。
