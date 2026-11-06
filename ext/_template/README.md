# 这是模板，不是一条拓展
#
# 投稿步骤：
#   1. 新建目录 ext/<你的 id>/（目录名必须等于 ext.json 里的 id）
#   2. 把 ext.json 抄进新目录，字段按 README.md 改
#   3. 放 main.js（Cordis 入口，export default { name, inject, apply(ctx) {} }），
#      样式放 style.css；入口文件名写进 ext.json 的 main
#   4. dart run tool/market_tool.dart pack 生成产物，再提 PR
#
# `_` 开头的目录（本目录、以及你自己的 `_src/` 草稿目录）不会被打进 zip，
# 也不会进市场目录。
