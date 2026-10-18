/// 投稿时会被拦下的东西（bundle 源码体检）。
///
/// 这两条不是「风格建议」，是**在内置页里必然出问题**的写法：
///
/// 1. `localStorage` / `sessionStorage` / `document.cookie` —— 拓展页是 App 用
///    `loadHtmlString` 塞进 WebView 的，来源是 **opaque origin**，读这些 API 直接
///    抛 SecurityError。要存数据就走 `antiSIT.call('storage.get/set')`（并在
///    `ext.json` 里声明 `storage`）。
/// 2. 外链资源（`<script src=https://…>`、`url(https://…)`、`fetch(…)` …）—— 市场装的
///    拓展默认**禁网**（App 注入 `connect-src 'none'` 的 CSP），没声明 `network` 就会
///    静默加载失败：插件看着是好的，实际什么都不显示。
///
/// 在 `pack` 与 `check` 里都跑一遍，让作者在本地就撞上，而不是装到手机上才发现。
///
/// 只查**代码**（html / js / css / svg），不查 md / txt / json：说明文件里提到
/// `localStorage` 是正常的（本包自己的 NOTICE 就会提），JSON 里的 URL 也可能只是数据。
library;

import 'dart:convert';

/// 会被当代码检查的扩展名。
const List<String> _codeExt = ['.html', '.htm', '.js', '.css', '.svg'];
/// 资源型外链：`<script src>` / `<link href>` / `url(...)` / `@import`。
/// **普通 `<a href>` 不算**——点外链由系统浏览器打开（内核的导航拦截），没问题。
final List<RegExp> _remoteResourceRes = [
  RegExp(
      r'''<(?:script|img|iframe|source|video|audio|embed|track|object)\b[^>]*\b(?:src|data)\s*=\s*["']?\s*https?://''',
      caseSensitive: false),
  RegExp(r'''<link\b[^>]*\bhref\s*=\s*["']?\s*https?://''', caseSensitive: false),
  RegExp(r'''url\(\s*["']?\s*https?://''', caseSensitive: false),
  RegExp(r'''@import\s+(?:url\()?\s*["']?\s*https?://''', caseSensitive: false),
];

/// 会走网络 API 的写法（禁网时必然失败）。
final List<RegExp> _remoteApiRes = [
  RegExp(r'''\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bEventSource\s*\(|navigator\.sendBeacon\s*\('''),
];

/// 存储 API：`localStorage.getItem(...)` / `localStorage[k]` / 以及「先赋给变量」这种
/// 裸引用（裸引用要求前面不是 `.`，免得把 `window.localStorage` 的说明文字也算上）。
final List<RegExp> _storageRes = [
  RegExp(r'''\b(?:localStorage|sessionStorage)\s*[.\[]'''),
  RegExp(r'''(?<![\w.$])(?:localStorage|sessionStorage)\b'''),
  RegExp(r'''document\s*\.\s*cookie'''),
];

bool _isCode(String path) {
  final lower = path.toLowerCase();
  return _codeExt.any(lower.endsWith);
}

/// 去掉注释再查：注释里提一句 `localStorage`（比如本包 NOTICE/代码说明）不该被拦。
///
/// `//` 行注释只在**前面不是冒号**时去掉——`https://…` 里的 `//` 得留着，
/// 不然真外链会被注释掉、反而查不出来。
String stripComments(String text) {
  var out = text.replaceAll(RegExp(r'<!--[\s\S]*?-->'), ' ');
  out = out.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), ' ');
  out = out.replaceAll(RegExp(r'(?<!:)//[^\n]*'), ' ');
  return out;
}

/// 体检一个 bundle 的源码。返回问题列表（空 = 通过），每条都能直接念给作者听。
///
/// [permissions] 是 `ext.json` 里声明的那几个（声明了 `network` 就不查外链那两条）。
List<String> lintBundle(Map<String, List<int>> files, {required List<String> permissions}) {
  final problems = <String>[];
  final allowNetwork = permissions.contains('network');

  for (final entry in files.entries) {
    final path = entry.key;
    if (!_isCode(path)) continue;
    final text = stripComments(_decode(entry.value));

    if (_storageRes.any((re) => re.hasMatch(text))) {
      problems.add('$path：用了 localStorage / sessionStorage / cookie —— 内置页是 opaque '
          'origin，这些 API 直接抛错或写不进去；存数据请用 antiSIT.call("storage.get"/'
          '"storage.set")，并在 ext.json 里声明 storage');
    }

    if (allowNetwork) continue;

    if (_remoteResourceRes.any((re) => re.hasMatch(text))) {
      problems.add('$path：引用了 http(s) 上的资源（脚本 / 样式 / 图片 / 字体），但 ext.json '
          '没声明 network —— 市场装的拓展默认禁网，这些资源加载不到；'
          '要么把资源打进包（自包含），要么声明 network。'
          '（普通超链接 <a href> 不受影响：点开会交给系统浏览器）');
    }
    if (_remoteApiRes.any((re) => re.hasMatch(text))) {
      problems.add('$path：用了网络 API（fetch / XMLHttpRequest / WebSocket 之类），'
          '但 ext.json 没声明 network —— 禁网时这些调用会失败；确实要联网就声明 network');
    }
  }
  return problems;
}

String _decode(List<int> bytes) => utf8.decode(bytes, allowMalformed: true);

/// 换行符检查——单列一条，因为它报错的样子最会骗人。
///
/// 本仓库靠 `.gitattributes` 把签出锁成 LF，而 `market.json` 的签名与每个 zip 的
/// sha256 都是**按字节**算的。源文件里混进 CRLF，本地打出来的 zip 就与 CI 重打包的
/// 对不上，报出来的却是「改了网页没重新打包」——Windows 上 `core.autocrlf=true` 加上
/// 从别处拷来的文件最容易撞上（2048 就这么栽过一次）。
List<String> lintLineEndings(Map<String, List<int>> files) => [
      for (final e in files.entries)
        if (_isTextFile(e.key) && _hasCrlf(e.value))
          '${e.key}：文件里是 CRLF 换行。本仓库锁 LF（sha256 与签名都按字节算），'
              '请把换行转成 LF 再打包（VS Code 右下角 CRLF → LF；提交那侧有 '
              '.gitattributes 兜住，但**打包读的是你磁盘上的字节**）',
    ];

/// 非二进制文件（换行检查管得比代码检查宽：ext.json、说明文件也会进 zip）。
bool _isTextFile(String path) {
  final lower = path.toLowerCase();
  return !lower.endsWith('.zip') &&
      !lower.endsWith('.png') &&
      !lower.endsWith('.jpg') &&
      !lower.endsWith('.jpeg') &&
      !lower.endsWith('.gif') &&
      !lower.endsWith('.webp') &&
      !lower.endsWith('.ico') &&
      !lower.endsWith('.woff') &&
      !lower.endsWith('.woff2');
}

bool _hasCrlf(List<int> bytes) {
  for (var i = 1; i < bytes.length; i++) {
    if (bytes[i - 1] == 13 && bytes[i] == 10) return true;
  }
  return false;
}
