import 'dart:convert';
import 'dart:io';

import 'package:antisit_market/market_catalog.dart';
import 'package:antisit_market/market_lint.dart';
import 'package:antisit_market/market_manifest.dart';
import 'package:antisit_market/market_packer.dart';
import 'package:antisit_market/market_signing.dart';
import 'package:test/test.dart';

/// 生成一份合法清单（用例里只覆盖要测的字段）。
Map<String, Object?> manifestJson({
  String id = 'sit.demo',
  String type = 'bundle',
  String version = '1.0.0',
  String url = '',
  Object permissions = const ['storage'],
  String minAppVersion = '1.16.0',
}) =>
    {
      'id': id,
      'name': '示例',
      'desc': '一句话简介',
      'author': 'AntiSIT',
      'category': '工具',
      'icon': '🧮',
      'type': type,
      if (version.isNotEmpty) 'version': version,
      if (url.isNotEmpty) 'url': url,
      'permissions': permissions,
      if (minAppVersion.isNotEmpty) 'minAppVersion': minAppVersion,
    };

ExtManifest parseOk(Map<String, Object?> raw, {String? id}) =>
    ExtManifest.parse(raw, dirId: id ?? '${raw['id']}');

void main() {
  group('清单校验', () {
    test('合法 bundle 通过', () {
      final m = parseOk(manifestJson());
      expect(m.id, 'sit.demo');
      expect(m.isBundle, isTrue);
      expect(m.sensitivePermissions, ['storage']);
    });

    test('id 与目录名不一致 → 报错', () {
      expect(() => ExtManifest.parse(manifestJson(), dirId: 'sit.other'),
          throwsA(isA<FormatException>()));
    });

    test('id 非法字符 → 报错', () {
      expect(() => parseOk(manifestJson(id: 'Sit.Demo!'), id: 'Sit.Demo!'),
          throwsA(isA<FormatException>()));
    });

    test('bundle 缺 version / version 不成 x.y.z → 报错', () {
      expect(() => parseOk(manifestJson(version: '')),
          throwsA(isA<FormatException>()));
      expect(() => parseOk(manifestJson(version: '1.0')),
          throwsA(isA<FormatException>()));
    });

    test('web 必须给 https 网址', () {
      expect(() => parseOk(manifestJson(type: 'web', version: '')),
          throwsA(isA<FormatException>()));
      expect(
          () => parseOk(manifestJson(type: 'web', version: '', url: 'http://a.com')),
          throwsA(isA<FormatException>()));
      final m = parseOk(manifestJson(type: 'web', version: '', url: 'https://a.com/x'));
      expect(m.isBundle, isFalse);
    });

    test('bundle 不许带 url', () {
      expect(() => parseOk(manifestJson(url: 'https://a.com')),
          throwsA(isA<FormatException>()));
    });

    test('权限拼错 → 报错（这就是白名单的意义）', () {
      expect(() => parseOk(manifestJson(permissions: ['stroage'])),
          throwsA(isA<FormatException>()));
      // 基础接口可以写，但不算敏感
      final m = parseOk(manifestJson(permissions: ['theme', 'storage', 'theme']));
      expect(m.permissions, ['theme', 'storage']); // 去重保序
      expect(m.sensitivePermissions, ['storage']);
    });

    test('分类白名单', () {
      final raw = manifestJson()..['category'] = '游戏';
      expect(() => parseOk(raw), throwsA(isA<FormatException>()));
    });

    test('名称 / 简介长度上限与 App 卡片一致', () {
      expect(() => parseOk(manifestJson()..['name'] = 'x' * 21),
          throwsA(isA<FormatException>()));
      expect(() => parseOk(manifestJson()..['desc'] = 'x' * 61),
          throwsA(isA<FormatException>()));
      expect(() => parseOk(manifestJson()..['icon'] = '五个字图标'),
          throwsA(isA<FormatException>()));
    });
  });

  group('打包', () {
    late Directory tmp;

    setUp(() => tmp = Directory.systemTemp.createTempSync('market_test'));
    tearDown(() => tmp.deleteSync(recursive: true));

    void write(String rel, String content) {
      final f = File('${tmp.path}/$rel')..parent.createSync(recursive: true);
      f.writeAsStringSync(content);
    }

    test('同样的源打出同样的字节（可复现 → 签名与 CI 才成立）', () {
      write('index.html', '<h1>hi</h1>');
      write('app.js', 'console.log(1)');
      final a = packDirectory(tmp.path);
      // 换个写入顺序 / 文件时间后仍应一致
      write('style.css', 'body{}');
      File('${tmp.path}/index.html').setLastModifiedSync(DateTime.now());
      final b = packDirectory(tmp.path);
      expect(sha256Hex(a), isNot(sha256Hex(b))); // 内容确实变了

      final c = packDirectory(tmp.path);
      expect(sha256Hex(b), sha256Hex(c));
    });

    test('作者说明 / _ 开头的目录不进包', () {
      write('index.html', '<h1>hi</h1>');
      write('README.md', '# 说明');
      write('_src/raw.js', 'x');
      write('_src/deep/y.js', 'y');
      final names = readZip(packDirectory(tmp.path)).keys.toList();
      expect(names, ['index.html']);
    });

    test('入口规则：优先根目录 index.html，否则第一个 html', () {
      expect(entryHtmlOf(['index.html', 'a.html']), 'index.html');
      expect(entryHtmlOf(['b.html', 'a.html']), 'a.html');
      expect(entryHtmlOf(['app/index.html']), 'app/index.html');
      expect(entryHtmlOf(['app/index.html', 'app/a.html']), 'app/index.html');
      expect(entryHtmlOf(['a.txt']), isNull);
    });

    test('读包时拦下 zip-slip 条目', () {
      expect(unsafeEntryName('../evil.html'), isTrue);
      expect(unsafeEntryName('/etc/passwd'), isTrue);
      expect(unsafeEntryName(r'C:\x.html'), isTrue);
      expect(unsafeEntryName('a/../b.html'), isTrue);
      expect(unsafeEntryName('a/b.html'), isFalse);
    });
  });

  group('目录', () {
    CatalogEntry entry(String id, {String type = 'bundle'}) => CatalogEntry(
          manifest: parseOk(manifestJson(id: id, type: type, version: type == 'web' ? '' : '1.0.0',
              url: type == 'web' ? 'https://a.com' : '')),
          zip: type == 'web' ? '' : 'dist/$id/1.0.0.zip',
          sha256: type == 'web' ? '' : 'a' * 64,
          size: 123,
        );

    test('条目按 id 排序，字段顺序固定（验签对象可复现）', () {
      final json1 = buildCatalogJson(keyId: 'k1', entries: [entry('sit.b'), entry('sit.a')]);
      final json2 = buildCatalogJson(keyId: 'k1', entries: [entry('sit.a'), entry('sit.b')]);
      expect(json1, json2);
      expect(json1, contains('"schema": 1'));
      expect(json1, contains('"keyId": "k1"'));
      expect(json1.endsWith('\n'), isTrue);
      final ids = (jsonDecode(json1)['extensions'] as List)
          .map((e) => e['id'])
          .toList();
      expect(ids, ['sit.a', 'sit.b']);
    });

    test('web 条目不带 zip / sha256 / size', () {
      final raw = jsonDecode(buildCatalogJson(keyId: 'k1', entries: [entry('sit.w', type: 'web')]));
      final e = (raw['extensions'] as List).first as Map;
      expect(e.containsKey('zip'), isFalse);
      expect(e['url'], 'https://a.com');
      expect(e['permissions'], ['storage']);
    });

    test('回读目录', () {
      final json = buildCatalogJson(keyId: 'k1', entries: [entry('sit.a')]);
      final back = parseCatalogEntries(jsonDecode(json));
      expect(back.single.id, 'sit.a');
      expect(back.single.sha256, 'a' * 64);
      expect(catalogKeyId(jsonDecode(json)), 'k1');
      expect(() => parseCatalogEntries({'schema': 2, 'extensions': []}),
          throwsA(isA<FormatException>()));
    });
  });

  group('签名', () {
    test('自己签的自己验得过，改一个字节就过不了', () async {
      final key = await generateKeyPair('k1');
      final bytes = utf8.encode('{"schema":1}');
      final sig = await signBase64(bytes, key);
      expect(await verifyBase64(bytes, signature: sig, publicKey: key.publicKey), isTrue);

      final tampered = utf8.encode('{"schema":2}');
      expect(await verifyBase64(tampered, signature: sig, publicKey: key.publicKey), isFalse);
    });

    test('别的私钥签的过不了（镜像伪造不了目录）', () async {
      final mine = await generateKeyPair('k1');
      final other = await generateKeyPair('k1');
      final bytes = utf8.encode('catalog');
      final sig = await signBase64(bytes, other);
      expect(await verifyBase64(bytes, signature: sig, publicKey: mine.publicKey), isFalse);
    });

    test('坏公钥 / 坏签名 / 长度不对 → false 而不是抛异常', () async {
      final key = await generateKeyPair('k1');
      final bytes = utf8.encode('catalog');
      final sig = await signBase64(bytes, key);
      expect(await verifyBase64(bytes, signature: 'not-base64!!', publicKey: key.publicKey),
          isFalse);
      expect(await verifyBase64(bytes, signature: sig, publicKey: 'AAAA'), isFalse);
      expect(await verifyBase64(bytes, signature: '', publicKey: key.publicKey), isFalse);
    });
  });

  group('源码体检（内置页里用不了的东西）', () {
    Map<String, List<int>> files(Map<String, String> map) => {
          for (final e in map.entries) e.key: utf8.encode(e.value),
        };

    test('localStorage / sessionStorage / cookie → 拦下，并指路 antiSIT storage', () {
      for (final bad in [
        'var n = localStorage.getItem("n");',
        'localStorage["n"] = 1;',
        'sessionStorage.setItem("n", 1);',
        'document.cookie = "a=1";',
      ]) {
        final problems = lintBundle(files({'app.js': bad}), permissions: const ['storage']);
        expect(problems, hasLength(1), reason: bad);
        expect(problems.single, contains('opaque'), reason: bad);
        expect(problems.single, contains('antiSIT'), reason: bad);
      }
    });

    test('注释里提一句 localStorage 不算（本包自己的说明就会提）', () {
      const src = r'''
// 上游这里用的是 localStorage，内置页里不能用，改成 antiSIT storage
/* 也不能用 window.localStorage */
antiSIT.call("storage.get", {key: "n"});
''';
      expect(lintBundle(files({'app.js': src}), permissions: const ['storage']), isEmpty);
    });

    test('没声明 network 却引外链 → 拦下；声明了就放行', () {
      const html = '<link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet">'
          '<script src="https://cdn.x.com/a.js"></script>'
          '<img src="//cdn.x.com/a.png">'
          '.a { background: url(https://x.com/a.png) }';
      const css = '@import url("https://x.com/a.css");';
      const js = 'fetch("https://x.com/api");';

      expect(lintBundle(files({'index.html': html}), permissions: const []), hasLength(1));
      expect(lintBundle(files({'style.css': css}), permissions: const []), hasLength(1));
      expect(lintBundle(files({'app.js': js}), permissions: const []), hasLength(1));
      // 声明 network 之后这几条都不该报（网络开了）
      expect(lintBundle(files({'index.html': html, 'style.css': css, 'app.js': js}),
          permissions: const ['network']), isEmpty);
    });

    test('普通超链接不算外链资源（点开由系统浏览器打开）', () {
      const html = '<a href="https://github.com/gabrielecirulli/2048">改编自上游</a>';
      expect(lintBundle(files({'index.html': html}), permissions: const []), isEmpty);
    });

    test('说明文件与 JSON 不查（只查 html/js/css/svg）', () {
      const md = '这里提到 localStorage 只是说明文字。';
      expect(lintBundle(files({'NOTICE.md': md}), permissions: const []), isEmpty);
      expect(lintBundle(files({'LICENSE.txt': md}), permissions: const []), isEmpty);
      expect(lintBundle(files({'data.json': '{"u":"https://x.com"}'}), permissions: const []),
          isEmpty);
    });
  });
}
