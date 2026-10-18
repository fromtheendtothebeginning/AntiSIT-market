/// 目录（`market.json`）的生成与编码。
///
/// 这里是**唯一**决定目录字节长什么样子的地方：App 验签就是拿这份字节算的，
/// 所以字段顺序固定、条目按 id 排序、**不放时间戳**（不然 CI 每次重算都不一样，
/// 「目录是否过期」交给仓库的 git 历史说，App 侧只关心缓存）。
library;

import 'dart:convert';

import 'market_manifest.dart';

/// 目录里的一条：清单 + 打包产物信息。
class CatalogEntry {
  const CatalogEntry({
    required this.manifest,
    this.zip = '',
    this.sha256 = '',
    this.size = 0,
  });

  final ExtManifest manifest;

  /// bundle：仓库内相对路径（App 按当前镜像拼完整 URL）。
  final String zip;

  /// bundle：zip 的 sha256，App 下载后必须与它一致才解压。
  final String sha256;
  final int size;

  String get id => manifest.id;

  Map<String, Object?> toJson() {
    final m = manifest;
    return {
      'id': m.id,
      'name': m.name,
      'desc': m.desc,
      'author': m.author,
      'category': m.category,
      if (m.icon.isNotEmpty) 'icon': m.icon,
      'type': m.type,
      if (m.version.isNotEmpty) 'version': m.version,
      if (m.type == 'web') 'url': m.url,
      if (m.homepage.isNotEmpty) 'homepage': m.homepage,
      if (m.isBundle) 'zip': zip,
      if (m.isBundle) 'sha256': sha256,
      if (m.isBundle) 'size': size,
      'permissions': m.permissions,
      if (m.minAppVersion.isNotEmpty) 'minAppVersion': m.minAppVersion,
    };
  }
}

/// 目录的 schema 版本：App 只认 1。
const int kCatalogSchema = 1;

/// 生成 `market.json` 的字节（含末尾换行）。
String buildCatalogJson({
  required String keyId,
  required List<CatalogEntry> entries,
}) {
  final sorted = [...entries]..sort((a, b) => a.id.compareTo(b.id));
  final map = <String, Object?>{
    'schema': kCatalogSchema,
    'keyId': keyId,
    'extensions': [for (final e in sorted) e.toJson()],
  };
  return '${const JsonEncoder.withIndent('  ').convert(map)}\n';
}

/// 解析一份目录（工具自检 / 测试用；App 侧另有自己的解析实现）。
List<CatalogEntry> parseCatalogEntries(Object? raw) {
  if (raw is! Map) throw const FormatException('目录要是一个 JSON 对象');
  if (raw['schema'] != kCatalogSchema) {
    throw FormatException('目录 schema 不认识：${raw['schema']}');
  }
  final list = raw['extensions'];
  if (list is! List) throw const FormatException('extensions 要是一个数组');
  final out = <CatalogEntry>[];
  for (final item in list) {
    if (item is! Map) throw const FormatException('每条拓展要是一个 JSON 对象');
    final id = '${item['id'] ?? ''}'.trim();
    if (id.isEmpty) throw const FormatException('目录里有条目缺 id');
    out.add(CatalogEntry(
      manifest: ExtManifest.parse(item, dirId: id),
      zip: '${item['zip'] ?? ''}',
      sha256: '${item['sha256'] ?? ''}',
      size: item['size'] is int ? item['size'] as int : 0,
    ));
  }
  return out;
}

/// 目录里声明的 keyId。
String catalogKeyId(Object? raw) {
  if (raw is! Map) throw const FormatException('目录要是一个 JSON 对象');
  return '${raw['keyId'] ?? ''}';
}
