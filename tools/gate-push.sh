#!/usr/bin/env bash
# gate-push.sh —— 把某个 lib 上传到 Worker（lib 只存在于 KV，不进 git）
#   bash tools/gate-push.sh <kid> <本地lib路径> [worker地址] [ADMIN_TOKEN]
set -e
KID="${1:?用法: bash tools/gate-push.sh <kid> <lib文件> [worker地址] [admin token]}"
LIB="${2:?缺 lib 文件}"
URL="${3:-${GATE_URL:-}}"
TOKEN="${4:-${ADMIN_TOKEN:-}}"
[ -z "$URL" ] && { echo "缺 worker 地址（参数3 或环境变量 GATE_URL）"; exit 1; }
[ -z "$TOKEN" ] && { echo "缺 admin token（参数4 或环境变量 ADMIN_TOKEN）"; exit 1; }
[ -f "$LIB" ] || { echo "找不到 $LIB"; exit 1; }

python - "$URL" "$TOKEN" "$KID" "$LIB" <<'PY'
import json,sys,urllib.request,ssl
url,token,kid,path=sys.argv[1:5]
code=open(path,encoding='utf-8').read()
body=json.dumps({"kid":kid,"code":code}).encode()
hdr={'Authorization':'Bearer '+token,'Content-Type':'application/json',
     # Cloudflare 会按 UA 拦 Python-urllib（error 1010），必须伪装成 curl
     'User-Agent':'curl/8.5.0'}
req=urllib.request.Request(url.rstrip('/')+'/admin/lib', data=body, headers=hdr, method='POST')
try:
    r=urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context())
    print(r.read().decode())
except Exception as e:
    print("失败:", e)
    if hasattr(e,'read'): print(e.read().decode())
    raise
PY
echo "✓ $KID 已上传（$(wc -c < "$LIB") 字节）"
