#!/usr/bin/env bash
# deploy.sh —— 在「本机 D:\pyc\skill」上一键发布（Windows / MINGW64 bash）
#   用法： bash tools/deploy.sh https://github.com/你/legado-sources.git [分支]
# 做四件事：写配置 → 构建 → 校验 → 推送
set -e
REPO_URL="${1:?用法: bash tools/deploy.sh https://github.com/<你>/<仓库>.git [分支]}"
BRANCH="${2:-main}"
cd "$(dirname "$0")/.."

# 1) 从远端 URL 解析 owner/repo，写进 config.json
OWNER_REPO=$(python - "$REPO_URL" <<'PY'
import sys,re
u=sys.argv[1].rstrip('/')
u=re.sub(r'\.git$','',u)
m=re.search(r'github\.com[/:]([^/]+)/([^/]+)$', u)
if not m: raise SystemExit('无法从 URL 解析 owner/repo: '+u)
print(m.group(1)+' '+m.group(2))
PY
)
set -- $OWNER_REPO
python - "$1" "$2" "$BRANCH" <<'PY'
import json,sys,io
owner,repo,branch=sys.argv[1:4]
p='config.json'
c=json.load(io.open(p,encoding='utf-8'))
c['owner']=owner; c['repo']=repo; c['branch']=branch
io.open(p,'w',encoding='utf-8').write(json.dumps(c,ensure_ascii=False,indent=2)+'\n')
print('config.json →', owner+'/'+repo+'@'+branch)
PY

# 2) 构建 + 自检
node scripts/build.mjs
node tools/simulate.mjs

# 3) 发布（git 若已存在则复用）
if [ ! -d .git ]; then
  git init -q
  git checkout -q -b "$BRANCH"
fi
printf 'node_modules/\n.sim-state.json\n' > .gitignore
git add -A
git -c user.name=legado-hub -c user.email=hub@local commit -q -m "build: $(date '+%Y-%m-%d %H:%M:%S')" || echo "(无改动可提交)"
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"
git push -u origin "$BRANCH"

echo
echo "✓ 已完成。分发用的深链："
python - <<'PY'
import json,io,urllib.parse
c=json.load(io.open('config.json',encoding='utf-8'))
raw=f"https://raw.githubusercontent.com/{c['owner']}/{c['repo']}/{c['branch']}/dist/rss/console.json"
print("  直连 : legado://import/rssSource?src="+urllib.parse.quote(raw,safe=''))
for m in c.get('mirrors',[])[1:]:
    print(f"  {m[:24]:<24}: legado://import/rssSource?src="+urllib.parse.quote(m+raw,safe=''))
PY
