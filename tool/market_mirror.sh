#!/usr/bin/env bash
# 把插件市场目录发布到自建镜像 https://anticraft.top/market/
#
# 为什么需要这一步：App 原来只从 jsDelivr 拉目录，而 jsDelivr 对 `@main` 分支路径
# 缓存 12 小时，且 **market.json 与 market.json.sig 是两个独立缓存条目**。
# 发新版后两者回收时间不一致，App 就会拿到「新目录 + 旧签名」，
# 验签必然失败 —— 表现就是「拓展发了新版，但市场里一直看不到更新」。
# 自建镜像由我们直接推、nginx 上是 no-cache，推完立刻生效。
#
# 用法：bash tool/market_mirror.sh
#   前置：dart run tool/market_tool.dart all（打包 + 生成目录 + 签名）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="root@47.100.125.150"
DIR="/var/www/anticraft/dist/market"

cd "$ROOT"

[ -f market.json ] || { echo "缺 market.json：先跑 dart run tool/market_tool.dart all" >&2; exit 1; }
[ -f market.json.sig ] || { echo "缺 market.json.sig：先跑 dart run tool/market_tool.dart all" >&2; exit 1; }

# 目录里引用的每个 zip 都必须存在，否则推上去就是一串 404
python - <<'PY'
import json, os, sys
cat = json.load(open('market.json', encoding='utf-8'))
missing = [e['zip'] for e in cat['extensions']
           if e.get('type') == 'bundle' and not os.path.isfile(e['zip'])]
if missing:
    sys.exit('这些 zip 不存在：' + '、'.join(missing))
print('目录里的', len(cat['extensions']), '条拓展，产物齐全')
PY

echo "推送目录 -> $HOST:$DIR"
ssh -o BatchMode=yes "$HOST" "mkdir -p '$DIR'"

# 先传成 .uploading 再 mv，避免 App 恰好读到半个文件
scp -o BatchMode=yes market.json "$HOST:$DIR/market.json.uploading" >/dev/null
scp -o BatchMode=yes market.json.sig "$HOST:$DIR/market.json.sig.uploading" >/dev/null

mkdir -p build
# 传 -T 给 tar 的清单必须是 LF 结尾的：Windows 上 Python 的 stdout 会给每行补 \r，
# 直接喂给 tar 会变成「带 \r 的文件名」，一条都找不到。这里显式按 \n 写。
python - <<'PY'
import json
cat = json.load(open('market.json', encoding='utf-8'))
zips = [e['zip'] for e in cat['extensions'] if e.get('type') == 'bundle']
with open('build/market_zips.txt', 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(zips) + '\n')
PY
tar -czf build/market_dist.tgz -T build/market_zips.txt
scp -o BatchMode=yes build/market_dist.tgz "$HOST:$DIR/dist.tgz" >/dev/null

ssh -o BatchMode=yes "$HOST" "cd '$DIR' \
  && mv market.json.uploading market.json \
  && mv market.json.sig.uploading market.json.sig \
  && tar -xzf dist.tgz && rm dist.tgz"

# 复核：服务器上的哈希必须与本机一致
WANT_JSON=$(sha256sum market.json | awk '{print $1}')
WANT_SIG=$(sha256sum market.json.sig | awk '{print $1}')
GOT_JSON=$(ssh -o BatchMode=yes "$HOST" "sha256sum '$DIR/market.json'" | awk '{print $1}')
GOT_SIG=$(ssh -o BatchMode=yes "$HOST" "sha256sum '$DIR/market.json.sig'" | awk '{print $1}')
[ "$WANT_JSON" = "$GOT_JSON" ] || { echo "market.json 哈希不一致：$GOT_JSON / $WANT_JSON" >&2; exit 1; }
[ "$WANT_SIG" = "$GOT_SIG" ] || { echo "market.json.sig 哈希不一致：$GOT_SIG / $WANT_SIG" >&2; exit 1; }
echo "哈希一致：$GOT_JSON"

rm -f build/market_dist.tgz build/market_zips.txt

echo "镜像就绪："
echo "  https://anticraft.top/market/market.json"
echo "  https://anticraft.top/market/market.json.sig"
