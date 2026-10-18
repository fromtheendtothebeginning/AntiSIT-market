/// 打包：把 `ext/<id>/` 打成**可复现**的 zip（同样的源永远得到同样的字节）。
///
/// 可复现是签名 / CI 的前提：`check` 会重新打一遍包，用 sha256 跟仓库里那份比，
/// 对不上就说明「改了网页忘了重新打包」。所以条目按名字排序、时间戳写死
/// （[kZipTimestamp]）、压缩级别固定——本机与 CI 打出来字节一致。
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';

/// zip 里所有条目的时间戳写死成这个（DOS 时间只支持 1980 以后）。
final DateTime kZipTimestamp = DateTime.utc(2020, 1, 1);

/// 不打进包里的文件：作者给市场看的说明 / 版本控制文件 / `_` 开头的草稿目录
/// （`_src/` 放原始工程、`_notes/` 放笔记都行，不会进用户手机）。
///
/// **LICENSE / NOTICE 照打**：MIT 这类许可要求「随副本带上许可与版权声明」，
/// 用户手机上的那份解压目录就是副本——所以它们属于要发出去的东西，不是仓库垃圾。
bool skipInZip(String relative) {
  for (final seg in relative.split('/')) {
    if (seg.startsWith('_')) return true;
  }
  final base = relative.split('/').last;
  return base == 'README.md' ||
      base == '.gitignore' ||
      base == '.DS_Store' ||
      base == 'Thumbs.db' ||
      base == '.gitkeep';
}

/// 打包一个目录（递归、排序、时间戳固定）。返回 zip 字节。
Uint8List packDirectory(String dir) {
  final root = Directory(dir);
  if (!root.existsSync()) throw StateError('目录不存在：$dir');

  final files = <String>[];
  for (final e in root.listSync(recursive: true)) {
    if (e is! File) continue;
    final rel = e.path.substring(root.path.length + 1).replaceAll(r'\', '/');
    if (skipInZip(rel)) continue;
    files.add(rel);
  }
  files.sort();

  final archive = Archive();
  for (final rel in files) {
    archive.addFile(ArchiveFile.bytes(rel, File('$dir/$rel').readAsBytesSync()));
  }
  return ZipEncoder().encodeBytes(
    archive,
    level: DeflateLevel.defaultCompression,
    modified: kZipTimestamp,
  );
}

/// 读一个 zip：`名字 → 字节`。不安全的条目名（zip-slip）直接抛错——
/// App 侧是「整条丢掉」，这边投稿时就得拦住，让作者自己改。
Map<String, Uint8List> readZip(List<int> bytes) {
  final out = <String, Uint8List>{};
  for (final f in ZipDecoder().decodeBytes(bytes).files) {
    if (!f.isFile) continue;
    if (unsafeEntryName(f.name)) throw FormatException('压缩包里有不安全的路径：${f.name}');
    out[f.name] = Uint8List.fromList(f.content as List<int>);
  }
  return out;
}

/// 与 App 侧 `normalizeEntryPath` 同一套判断：绝对路径 / 盘符 / 含 `..` 一律不安全。
bool unsafeEntryName(String raw) {
  final s = raw.replaceAll(r'\', '/').trim();
  if (s.isEmpty || s.startsWith('/')) return true;
  if (RegExp(r'^[A-Za-z]:').hasMatch(s)) return true;
  return s.split('/').contains('..');
}

/// 入口 html：与 App 侧 `entryFileOf` 同一套规则（去掉只有一层顶层目录的那层、
/// 优先根目录 `index.html`、否则排序后第一个 `*.html`）。找不到返回 null。
String? entryHtmlOf(Iterable<String> names) {
  final all = names.toList();
  if (all.isEmpty) return null;
  final tops = {for (final n in all) n.split('/').first};
  final strip =
      tops.length == 1 && all.every((n) => n.contains('/')) ? '${tops.first}/' : '';
  final rel = [
    for (final n in all)
      if (n.startsWith(strip)) n.substring(strip.length),
  ];
  final htmls = [
    for (final n in rel)
      if (n.toLowerCase().endsWith('.html')) n,
  ]..sort();
  if (htmls.contains('index.html')) return '${strip}index.html';
  return htmls.isEmpty ? null : '$strip${htmls.first}';
}

/// sha256 小写十六进制——目录里记的就是这份值，App 下载后照着重算。
String sha256Hex(List<int> bytes) => sha256.convert(bytes).toString();

/// 人类可读的体积。
String humanSize(int bytes) => bytes < 1024
    ? '$bytes B'
    : bytes < 1024 * 1024
        ? '${(bytes / 1024).toStringAsFixed(1)} KB'
        : '${(bytes / 1024 / 1024).toStringAsFixed(2)} MB';

/// 读 JSON 文件（带文件名上下文，报错好定位）。
Object? readJsonFile(String path) {
  final f = File(path);
  if (!f.existsSync()) throw StateError('文件不存在：$path');
  return jsonDecode(f.readAsStringSync());
}
