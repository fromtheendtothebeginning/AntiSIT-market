/// `ext/<id>/ext.json`：作者给一条拓展写的清单，也是市场校验的唯一依据。
///
/// 校验从严不从严都不好，所以这里的尺度是「宁可投稿时被拦，也不让坏数据进目录」：
/// 字段缺失 / 越界 / 权限名写错 / 网址不是 https 一律报错，错误消息直接给作者看。
library;

/// 敏感接口：**必须**在 `permissions` 里声明，App 安装时会列给用户看。
///
/// * `storage` —— 读写这条拓展自己的键值存储（`plugin.ext.data.<id>.*`）
/// * `network` —— 运行时联网（zip 包默认禁网，见 App 侧的 CSP）
const Set<String> kSensitivePermissions = {'storage', 'network'};

/// 基础接口：只跟界面有关（读配色、弹提示、关页面、改自己的卡片），
/// 声明不声明都放行——放进白名单是为了拦住 `stroage` 这种手滑拼错。
const Set<String> kBasicPermissions = {'theme', 'toast', 'close', 'card'};

/// 允许的分类（市场里按它筛选）。
const List<String> kCategories = ['学习', '工具', '生活', '娱乐', '其他'];

/// 卡片的名称 / 简介上限，与 App 侧 `ExtensionItem.nameMaxLength` / `descMaxLength` 对齐。
const int kNameMax = 20;
const int kDescMax = 60;

/// 图标：图片网址，或不超过 4 个字的文字 / emoji（与 App 侧 `iconTextMaxLength` 对齐）。
const int kIconTextMax = 4;

/// 单个 zip 的体积上限：超了说明这拓展不是「小功能」，该考虑做成独立 App。
const int kMaxZipBytes = 2 * 1024 * 1024;

final RegExp _idRe = RegExp(r'^[a-z0-9][a-z0-9._-]*$');
final RegExp _versionRe = RegExp(r'^\d+\.\d+\.\d+$');

/// 一条拓展的清单。
class ExtManifest {
  const ExtManifest({
    required this.id,
    required this.name,
    required this.desc,
    required this.author,
    required this.category,
    required this.icon,
    required this.type,
    required this.version,
    required this.url,
    required this.homepage,
    required this.permissions,
    required this.minAppVersion,
  });

  /// 稳定 id：`sit.my-tool` 这种小写点分串，必须与 `ext/<id>/` 目录名一致。
  final String id;
  final String name;
  final String desc;
  final String author;
  final String category;
  final String icon;

  /// `bundle`（自包含 zip）或 `web`（第三方网址）。
  final String type;

  /// bundle 必填；web 可空。
  final String version;

  /// web 必填：https 网址。
  final String url;
  final String homepage;
  final List<String> permissions;

  /// 可空：`x.y.z`，低于它的 App 装不了（市场里显示「需要升级 App」）。
  final String minAppVersion;

  bool get isBundle => type == 'bundle';

  /// 解析并校验。`dirId` 是它所在的目录名，用来挡住「目录名和 id 对不上」。
  static ExtManifest parse(Object? raw, {required String dirId}) {
    if (raw is! Map) throw const FormatException('ext.json 要是一个 JSON 对象');

    String str(String key, {int? max, bool required = false}) {
      final v = '${raw[key] ?? ''}'.trim();
      if (v.isEmpty) {
        if (required) throw FormatException('缺字段 $key');
        return '';
      }
      if (max != null && v.length > max) {
        throw FormatException('$key 最多 $max 个字（现在 ${v.length}）');
      }
      return v;
    }

    final id = str('id', required: true);
    if (!_idRe.hasMatch(id) || id.length < 3) {
      throw FormatException('id「$id」不合法：小写字母 / 数字开头，后面可跟 . _ -，至少 3 位');
    }
    if (id != dirId) {
      throw FormatException('id「$id」与目录名「$dirId」不一致（目录必须是 ext/$id/）');
    }

    final type = str('type', required: true);
    if (type != 'bundle' && type != 'web') {
      throw FormatException('type 只能是 bundle（自包含 zip）或 web（网址），现在是「$type」');
    }

    final version = str('version');
    if (type == 'bundle') {
      if (!_versionRe.hasMatch(version)) {
        throw FormatException('bundle 拓展的 version 要写成 x.y.z，现在是「$version」');
      }
    } else if (version.isNotEmpty && !_versionRe.hasMatch(version)) {
      throw FormatException('version 要写成 x.y.z，现在是「$version」');
    }

    final url = str('url', max: 300);
    if (type == 'web') {
      final uri = Uri.tryParse(url);
      if (uri == null || uri.host.isEmpty) throw FormatException('web 拓展的 url 不是个网址：$url');
      if (uri.scheme != 'https') throw const FormatException('web 拓展的 url 必须走 https');
    } else if (url.isNotEmpty) {
      throw const FormatException('bundle 拓展不该有 url（内容在 zip 里）');
    }

    final homepage = str('homepage', max: 300);
    if (homepage.isNotEmpty && !homepage.startsWith('https://')) {
      throw const FormatException('homepage 必须走 https');
    }

    final category = str('category', required: true);
    if (!kCategories.contains(category)) {
      throw FormatException('category「$category」不在允许的分类里：${kCategories.join(' / ')}');
    }

    final icon = str('icon', max: 300);
    if (icon.isNotEmpty && !icon.startsWith('http') && icon.length > kIconTextMax) {
      throw FormatException('icon 要么是 http(s) 图片网址，要么不超过 $kIconTextMax 个字');
    }

    final minAppVersion = str('minAppVersion');
    if (minAppVersion.isNotEmpty && !_versionRe.hasMatch(minAppVersion)) {
      throw FormatException('minAppVersion 要写成 x.y.z，现在是「$minAppVersion」');
    }

    final rawPerms = raw['permissions'] ?? const [];
    if (rawPerms is! List) throw const FormatException('permissions 要是一个数组');
    final permissions = <String>[];
    for (final p in rawPerms) {
      final name = '$p'.trim();
      if (!kSensitivePermissions.contains(name) && !kBasicPermissions.contains(name)) {
        throw FormatException('权限「$name」不存在：只能写 '
            '${[...kSensitivePermissions, ...kBasicPermissions].join(' / ')}');
      }
      if (!permissions.contains(name)) permissions.add(name);
    }

    return ExtManifest(
      id: id,
      name: str('name', max: kNameMax, required: true),
      desc: str('desc', max: kDescMax, required: true),
      author: str('author', max: 24, required: true),
      category: category,
      icon: icon,
      type: type,
      version: version,
      url: url,
      homepage: homepage,
      permissions: permissions,
      minAppVersion: minAppVersion,
    );
  }

  /// 敏感权限（要列给用户看的那几个）。
  List<String> get sensitivePermissions =>
      [for (final p in permissions) if (kSensitivePermissions.contains(p)) p];
}

/// 权限的中文说明（市场页、安装弹窗、投稿指南共用同一份文案）。
const Map<String, String> kPermissionLabels = {
  'storage': '在本机保存数据（记设置、记历史）',
  'network': '运行时联网',
  'theme': '读取 App 配色（只读）',
  'toast': '弹一条 App 风格的提示',
  'close': '关闭自己的页面',
  'card': '改自己在列表里那张卡片的名字 / 简介 / 图标',
};
