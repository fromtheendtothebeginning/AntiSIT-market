/// AntiSIT 插件市场：目录构建 / 打包 / 签名 / 校验的 CLI。
///
/// ```
/// dart run tool/market_tool.dart keygen      # 维护者本机跑一次：生成密钥对
/// dart run tool/market_tool.dart pack        # ext/<id>/ → dist/<id>/<版本>.zip（可复现）
/// dart run tool/market_tool.dart build       # 扫 ext/** + dist/** → market.json
/// dart run tool/market_tool.dart sign        # 用本机私钥签 market.json → market.json.sig
/// dart run tool/market_tool.dart all         # pack + build + sign
/// dart run tool/market_tool.dart check       # CI / 投稿前自检（**只用公钥**，不需要私钥）
/// ```
library;

import 'dart:convert';
import 'dart:io';

import 'package:antisit_market/market_catalog.dart';
import 'package:antisit_market/market_lint.dart';
import 'package:antisit_market/market_manifest.dart';
import 'package:antisit_market/market_packer.dart';
import 'package:antisit_market/market_signing.dart';

/// 一条拓展在仓库里的源目录。
class _Source {
  _Source(this.manifest, this.dir);
  final ExtManifest manifest;
  final String dir;
  String get id => manifest.id;
}

Future<void> main(List<String> args) async {
  final root = _repoRoot();
  final cmd = args.isEmpty ? 'help' : args.first;
  try {
    switch (cmd) {
      case 'keygen':
        await _keygen(root, args.skip(1).toList());
      case 'pack':
        _pack(root);
      case 'build':
        _build(root);
      case 'sign':
        await _sign(root);
      case 'all':
        _pack(root);
        _build(root);
        await _sign(root);
        print('\n目录已更新：market.json + market.json.sig（记得提交）');
      case 'check':
        await _check(root);
      case 'help':
      default:
        _help();
    }
  } on FormatException catch (e) {
    stderr.writeln('✗ ${e.message}');
    exit(2);
  } on StateError catch (e) {
    stderr.writeln('✗ ${e.message}');
    exit(2);
  }
}

void _help() => print('''
AntiSIT 插件市场工具

  keygen [--key-id k1] [--force]   生成密钥对（维护者本机，只跑一次）
  pack                             打包 ext/** → dist/**
  build                            生成 market.json
  sign                             签名 → market.json.sig
  all                              pack + build + sign
  check                            自检 + 验签（CI 用）

目录约定：一条拓展 = ext/<id>/ 目录 + 里面的 ext.json（见 README.md）。
''');

// ==================== 路径 ====================

String _repoRoot() {
  var dir = File.fromUri(Platform.script).parent; // tool/
  for (var i = 0; i < 4; i++) {
    if (File('${dir.path}/pubspec.yaml').existsSync()) return dir.path;
    dir = dir.parent;
  }
  return Directory.current.path;
}

String _extRoot(String root) => '$root/ext';
String _distRoot(String root) => '$root/dist';

// ==================== keygen ====================

Future<void> _keygen(String root, List<String> args) async {
  final keyId = _argValue(args, '--key-id') ?? 'k1';
  final force = args.contains('--force');
  final keyPath = '$root/keys/market.key';
  final pubPath = '$root/keys/market.pub';

  if (File(keyPath).existsSync() && !force) {
    stderr.writeln('✗ $keyPath 已存在。真要换密钥加 --force（换完必须发新版 App，'
        '否则旧版 App 不认新 keyId）');
    exit(2);
  }

  final key = await generateKeyPair(keyId);
  File(keyPath)
    ..createSync(recursive: true)
    ..writeAsStringSync('${const JsonEncoder.withIndent('  ').convert(key.toJson())}\n');
  final keys = File(pubPath).existsSync() ? readPubKeys(pubPath) : <String, String>{};
  keys[keyId] = key.publicKey;
  writePubKeys(pubPath, keys);

  print('✓ 私钥：$keyPath（**已在 .gitignore 里，别提交、别传服务器**）');
  print('✓ 公钥：$pubPath');
  print('\n把这一段贴进 App（packages/plugin_ext/lib/market/market_source.dart）：\n');
  print(dartPubKeySnippet(keys));
}

String? _argValue(List<String> args, String name) {
  final i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// ==================== 扫描 ====================

/// 扫 `ext/**`：目录名必须是 id，`_` 开头的目录（模板 / 草稿）跳过。
List<_Source> _scan(String root) {
  final root_ = Directory(_extRoot(root));
  if (!root_.existsSync()) return const [];
  final out = <_Source>[];
  for (final d in root_.listSync().whereType<Directory>()) {
    final name = d.path.replaceAll(r'\', '/').split('/').last;
    if (name.startsWith('_')) continue;
    final ext = File('${d.path}/ext.json');
    if (!ext.existsSync()) throw FormatException('ext/$name/ 里没有 ext.json');
    out.add(_Source(ExtManifest.parse(readJsonFile(ext.path), dirId: name), d.path));
  }
  out.sort((a, b) => a.id.compareTo(b.id));
  return out;
}

/// bundle 拓展的 zip 仓库内相对路径。
String _zipRel(ExtManifest m) => 'dist/${m.id}/${m.version}.zip';

// ==================== pack ====================

void _pack(String root) {
  final sources = _scan(root);
  final wanted = <String>{};

  for (final s in sources) {
    final m = s.manifest;
    if (!m.isBundle) {
      // web 型没有产物：清掉可能残留的旧目录，别在仓库里留垃圾
      final stale = Directory('${_distRoot(root)}/${m.id}');
      if (stale.existsSync()) stale.deleteSync(recursive: true);
      print('· ${m.id}（web 网址，无产物）');
      continue;
    }
    final bytes = packDirectory(s.dir);
    if (bytes.length > kMaxZipBytes) {
      throw FormatException('${m.id} 打出来 ${humanSize(bytes.length)}，'
          '超过上限 ${humanSize(kMaxZipBytes)}');
    }
    final files = readZip(bytes);
    if (entryHtmlOf(files.keys) == null) {
      throw FormatException('${m.id} 的压缩包里没找到 html（根目录放一个 index.html 最省事）');
    }
    // 体检：内置页里用不了的东西（localStorage / 没声明 network 却引外链）
    final lint = lintBundle(files, permissions: m.permissions);
    if (lint.isNotEmpty) {
      throw FormatException('${m.id} 有问题：\n  - ${lint.join('\n  - ')}');
    }
    final rel = _zipRel(m);
    final out = File('$root/$rel')..parent.createSync(recursive: true);
    out.writeAsBytesSync(bytes);
    wanted.add(rel);
    print('✓ $rel  ${humanSize(bytes.length)}  sha256=${sha256Hex(bytes).substring(0, 12)}…');
  }

  // 清掉没被现在这版引用的旧产物（换版本号后旧 zip 不该留在仓库里）
  final dist = Directory(_distRoot(root));
  if (dist.existsSync()) {
    for (final f in dist.listSync(recursive: true).whereType<File>()) {
      final rel = f.path.substring(root.length + 1).replaceAll(r'\', '/');
      if (!wanted.contains(rel)) {
        f.deleteSync();
        print('· 清理旧产物 $rel');
      }
    }
  }
}

// ==================== build / sign ====================

/// 签名用的 keyId：优先本机私钥，其次已有目录（CI 重算时保持一致），最后公钥文件里那把。
String _keyIdFor(String root) {
  final keyFile = File('$root/keys/market.key');
  if (keyFile.existsSync()) return MarketKeyPair.fromJson(readJsonFile(keyFile.path)).keyId;
  final catalog = File('$root/market.json');
  if (catalog.existsSync()) {
    final id = catalogKeyId(readJsonFile(catalog.path));
    if (id.isNotEmpty) return id;
  }
  final keys = readPubKeys('$root/keys/market.pub');
  if (keys.length == 1) return keys.keys.first;
  throw StateError('认不出该用哪把密钥签名：跑一次 keygen，或让 market.json 里带上 keyId');
}

List<CatalogEntry> _entries(String root, {required bool requireArtifacts}) {
  final out = <CatalogEntry>[];
  for (final s in _scan(root)) {
    final m = s.manifest;
    if (!m.isBundle) {
      out.add(CatalogEntry(manifest: m));
      continue;
    }
    final rel = _zipRel(m);
    final f = File('$root/$rel');
    if (!f.existsSync()) {
      if (requireArtifacts) throw StateError('缺少打包产物 $rel：先跑 pack');
      continue;
    }
    final bytes = f.readAsBytesSync();
    out.add(CatalogEntry(
      manifest: m,
      zip: rel,
      sha256: sha256Hex(bytes),
      size: bytes.length,
    ));
  }
  return out;
}

void _build(String root) {
  final json = buildCatalogJson(keyId: _keyIdFor(root), entries: _entries(root, requireArtifacts: true));
  File('$root/market.json').writeAsStringSync(json);
  print('✓ market.json（${_entries(root, requireArtifacts: true).length} 条）');
}

Future<void> _sign(String root) async {
  final keyFile = File('$root/keys/market.key');
  if (!keyFile.existsSync()) {
    throw StateError('私钥不在（$keyFile 不存在）：签名只能在维护者本机做');
  }
  final key = MarketKeyPair.fromJson(readJsonFile(keyFile.path));
  // 防手滑：私钥必须与仓库里公开的那把公钥对应
  final pub = readPubKeys('$root/keys/market.pub')[key.keyId];
  if (pub != null && pub != key.publicKey) {
    throw StateError('私钥与 keys/market.pub 里的「${key.keyId}」公钥不匹配');
  }
  final bytes = File('$root/market.json').readAsBytesSync();
  final sig = await signBase64(bytes, key);
  File('$root/market.json.sig').writeAsStringSync('$sig\n');
  print('✓ market.json.sig（keyId=${key.keyId}）');
}

// ==================== check ====================

Future<void> _check(String root) async {
  final problems = <String>[];
  final sources = _scan(root);

  if (sources.isEmpty) problems.add('ext/ 下一条拓展都没有');

  // 1) 逐条：源目录能打出包、仓库里的 zip 是最新的、market.json 里的记录对得上
  final catalogFile = File('$root/market.json');
  if (!catalogFile.existsSync()) {
    problems.add('缺 market.json（跑 build）');
  }
  List<CatalogEntry> declared = const [];
  if (catalogFile.existsSync()) {
    try {
      declared = parseCatalogEntries(readJsonFile(catalogFile.path));
    } catch (e) {
      problems.add('market.json 解析失败：$e');
    }
  }
  final declaredById = {for (final e in declared) e.id: e};

  for (final s in sources) {
    final m = s.manifest;
    if (m.type == 'web') {
      final d = declaredById[m.id];
      if (d == null) problems.add('${m.id}：market.json 里没有它（跑 build）');
      continue;
    }
    final rel = _zipRel(m);
    final f = File('$root/$rel');
    if (!f.existsSync()) {
      problems.add('${m.id}：缺产物 $rel（跑 pack）');
      continue;
    }
    final committed = f.readAsBytesSync();
    final freshHash = sha256Hex(packDirectory(s.dir));

    if (committed.length > kMaxZipBytes) {
      problems.add('${m.id}：产物 ${humanSize(committed.length)} 超过 ${humanSize(kMaxZipBytes)}');
    }
    if (sha256Hex(committed) != freshHash) {
      problems.add('${m.id}：dist 里的 zip 与 ext/${m.id}/ 的源对不上'
          '（改了网页没重新打包 → 跑 pack）');
    }
    try {
      readZip(committed); // 产物本身读得动（条目名安全）
    } catch (e) {
      problems.add('${m.id}：压缩包读不了：$e');
    }
    // 体检**源码现状**（不是 dist 里那份旧包）：投稿时踩到 localStorage / 没声明 network
    // 这类坑，要在这儿就被拦下。dist 与源是否同步由上面的哈希比对负责。
    try {
      final fresh = readZip(packDirectory(s.dir));
      if (entryHtmlOf(fresh.keys) == null) problems.add('${m.id}：压缩包里没有 html 入口');
      for (final p in lintBundle(fresh, permissions: m.permissions)) {
        problems.add('${m.id}：$p');
      }
    } catch (e) {
      problems.add('${m.id}：打包失败：$e');
    }
    final d = declaredById[m.id];
    if (d == null) {
      problems.add('${m.id}：market.json 里没有它（跑 build）');
    } else {
      if (d.sha256 != freshHash) problems.add('${m.id}：market.json 里的 sha256 不是最新的（跑 build）');
      if (d.zip != rel) problems.add('${m.id}：market.json 里的 zip 路径该是 $rel');
    }
  }

  // 2) 没声明的条目 / dist 里的孤儿文件
  final sourceIds = {for (final s in sources) s.id};
  for (final d in declared) {
    if (!sourceIds.contains(d.id)) problems.add('market.json 里有 ${d.id}，但 ext/${d.id}/ 不存在');
  }
  final dist = Directory(_distRoot(root));
  if (dist.existsSync()) {
    for (final f in dist.listSync(recursive: true).whereType<File>()) {
      final rel = f.path.substring(root.length + 1).replaceAll(r'\', '/');
      final declaredRels = {for (final e in declared) if (e.zip.isNotEmpty) e.zip};
      if (!declaredRels.contains(rel)) problems.add('dist 里有多余文件 $rel（那是旧版本？跑 pack 清理）');
    }
  }

  // 3) 目录必须是最新重算结果的字节（保证验签对象可复现）
  if (catalogFile.existsSync()) {
    try {
      final fresh = buildCatalogJson(
          keyId: catalogKeyId(readJsonFile(catalogFile.path)),
          entries: _entries(root, requireArtifacts: true));
      if (fresh != catalogFile.readAsStringSync()) {
        problems.add('market.json 与 ext/** 重算结果不一致（跑 build）');
      }
    } catch (e) {
      problems.add('重算 market.json 失败：$e');
    }
  }

  // 4) 验签（CI 只有公钥）
  final sigFile = File('$root/market.json.sig');
  if (!sigFile.existsSync()) {
    problems.add('缺 market.json.sig（维护者本机跑 sign）');
  } else if (catalogFile.existsSync()) {
    final keys = readPubKeys('$root/keys/market.pub');
    final keyId = catalogKeyId(readJsonFile(catalogFile.path));
    final pub = keys[keyId];
    if (pub == null) {
      problems.add('目录声明的 keyId「$keyId」不在 keys/market.pub 里');
    } else {
      final ok = await verifyBase64(
        catalogFile.readAsBytesSync(),
        signature: sigFile.readAsStringSync().trim(),
        publicKey: pub,
      );
      if (!ok) problems.add('market.json.sig 验签失败：目录被改过，或不是持私钥的人签的');
    }
  }

  // 报告
  print('检查了 ${sources.length} 条拓展：');
  for (final s in sources) {
    final m = s.manifest;
    final d = declaredById[m.id];
    print('  · ${m.id.padRight(28)} ${m.type == 'web' ? 'web  ' : 'bundle'}'
        ' v${m.version.isEmpty ? '-' : m.version}'
        ' ${m.type == 'bundle' && d != null ? humanSize(d.size) : ''}'
        ' 权限[${m.sensitivePermissions.join(',')}]');
  }
  if (problems.isEmpty) {
    print('\n✓ 全部通过（打包产物、目录、签名都一致）');
    return;
  }
  stderr.writeln('\n✗ ${problems.length} 个问题：');
  for (final p in problems) {
    stderr.writeln('  - $p');
  }
  exit(1);
}
