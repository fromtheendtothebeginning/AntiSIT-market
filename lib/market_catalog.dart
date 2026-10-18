/// 目录（`market.json`）的生成与编码。
///
/// 这里是**唯一**决定目录字节长什么样子的地方：App 验签就是拿这份字节算的，
/// 所以字段顺序固定、条目按 id 排序、**不放时间戳**（不然 CI 每次重算都不一样，
/// 「目录是否过期」交给仓库的 git 历史说，App 侧只关心缓存）。
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';

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
///
/// [publicKey] 只在「作者自己发的源」里写：这种目录没有内置公钥可用，得自报家门
/// （App 首次添加该源时把这个公钥连同指纹拿给用户确认，之后固定住）。
/// 官方目录不写——它的公钥内置在 App 里，写进来反而给了「连公钥一起换掉」的伪造空间。
String buildCatalogJson({
  required String keyId,
  required List<CatalogEntry> entries,
  String publicKey = '',
}) {
  final sorted = [...entries]..sort((a, b) => a.id.compareTo(b.id));
  final map = <String, Object?>{
    'schema': kCatalogSchema,
    'keyId': keyId,
    if (publicKey.isNotEmpty) 'publicKey': publicKey,
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

/// 目录里自报的公钥（只有作者自己发的源会写；官方目录返回空串）。
String catalogPublicKey(Object? raw) {
  if (raw is! Map) throw const FormatException('目录要是一个 JSON 对象');
  return '${raw['publicKey'] ?? ''}'.trim();
}

/// 公钥指纹：`sha256(公钥字节)` 的前 12 位十六进制，按 4 位一组（`A1B2-C3D4-E5F6`）。
///
/// App 侧算的是同一套（`plugin_ext/market/market_sources.dart`），作者把这个指纹
/// 写在自己的 README / 分享文案里，用户添加源时核对的就是它。
String keyFingerprint(String publicKeyBase64) {
  final bytes = base64Decode(publicKeyBase64);
  final hex = sha256.convert(bytes).toString().toUpperCase();
  final head = hex.substring(0, 12);
  return '${head.substring(0, 4)}-${head.substring(4, 8)}-${head.substring(8, 12)}';
}
