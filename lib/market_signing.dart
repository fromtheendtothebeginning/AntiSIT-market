/// 目录签名：Ed25519（`package:cryptography`，纯 Dart，本工具与 App 用同一套）。
///
/// 分工：**私钥只在维护者本机**（`keys/market.key`，绝不提交、绝不进 CI），
/// 仓库里只放公钥（`keys/market.pub`）。CI 拿公钥验签，所以 CI 只能证明
/// 「这份目录是持私钥的人签的」，自己签不出目录。
///
/// 因为验签跟「从哪儿下载」无关，目录可以随便挂镜像（jsDelivr / 自己的服务器），
/// 镜像篡改会被验签挡住——这是签名换来的自由度。
library;

import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';

/// 一对密钥：32 字节种子 + 32 字节公钥，都按 base64 存。
class MarketKeyPair {
  const MarketKeyPair({required this.keyId, required this.seed, required this.publicKey});

  final String keyId;
  final String seed;
  final String publicKey;

  Map<String, Object?> toJson() => {
        'keyId': keyId,
        'privateKey': seed,
        'publicKey': publicKey,
      };

  static MarketKeyPair fromJson(Object? raw) {
    if (raw is! Map) throw const FormatException('密钥文件要是一个 JSON 对象');
    return MarketKeyPair(
      keyId: '${raw['keyId'] ?? ''}',
      seed: '${raw['privateKey'] ?? ''}',
      publicKey: '${raw['publicKey'] ?? ''}',
    );
  }

  SimpleKeyPairData get _keyPair => SimpleKeyPairData(
        base64Decode(seed),
        publicKey: SimplePublicKey(base64Decode(publicKey), type: KeyPairType.ed25519),
        type: KeyPairType.ed25519,
      );
}

Future<MarketKeyPair> generateKeyPair(String keyId) async {
  final kp = await Ed25519().newKeyPair();
  final pub = await kp.extractPublicKey();
  return MarketKeyPair(
    keyId: keyId,
    seed: base64Encode(await kp.extractPrivateKeyBytes()),
    publicKey: base64Encode(pub.bytes),
  );
}

/// 对字节签名 → base64。
Future<String> signBase64(List<int> bytes, MarketKeyPair key) async {
  final sig = await Ed25519().sign(bytes, keyPair: key._keyPair);
  return base64Encode(sig.bytes);
}

/// 验签：`signature` 是 base64 签名，`publicKey` 是 base64 公钥。
/// 长度不对 / 公钥坏 / 签名不符都返回 false（不抛异常，调用方按「验签失败」处理）。
Future<bool> verifyBase64(
  List<int> bytes, {
  required String signature,
  required String publicKey,
}) async {
  try {
    final sig = base64Decode(signature);
    if (sig.length != 64) return false;
    final pub = base64Decode(publicKey);
    if (pub.length != 32) return false;
    return await Ed25519().verify(
      bytes,
      signature: Signature(sig, publicKey: SimplePublicKey(pub, type: KeyPairType.ed25519)),
    );
  } catch (_) {
    return false;
  }
}

/// 公钥文件：`{"k1": "<base64>"}`——留多把钥匙是为了以后换公钥（旧 App 不认识新 keyId 时
/// 只会提示「目录用的密钥不认识」，不会拿到坏数据）。
Map<String, String> readPubKeys(String path) {
  final f = File(path);
  if (!f.existsSync()) throw StateError('公钥文件不存在：$path（先在维护者本机跑 keygen）');
  final raw = jsonDecode(f.readAsStringSync());
  if (raw is! Map) throw StateError('公钥文件要是一个 JSON 对象：$path');
  return {
    for (final e in raw.entries)
      '${e.key}': '${e.value}',
  };
}

void writePubKeys(String path, Map<String, String> keys) {
  final sorted = keys.keys.toList()..sort();
  File(path)
    ..createSync(recursive: true)
    ..writeAsStringSync('${const JsonEncoder.withIndent('  ').convert({
          for (final k in sorted) k: keys[k],
        })}\n');
}

/// 给维护者的便利：把公钥贴进 App 的那段 Dart。
String dartPubKeySnippet(Map<String, String> keys) {
  final lines = [
    for (final e in keys.entries) "  '${e.key}': '${e.value}',",
  ].join('\n');
  return 'const Map<String, String> kMarketPublicKeys = {\n$lines\n};';
}
