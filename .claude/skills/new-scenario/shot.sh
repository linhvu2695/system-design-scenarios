#!/usr/bin/env bash
# Screenshot one simulation run, revealed, in headless Chrome.
#   shot.sh <id> <setup> <situation> [steps=20] [width=860] [play]
# Mounts scenarios/<id>/sim.js on a temporary page, clicks Step <steps> times (20 jumps
# to the end of any run), optionally presses play to catch an animation part-way, and
# writes the PNG to $OUT (default: /tmp). Needs `make serve` on 127.0.0.1:8090.
set -euo pipefail
id=$1 setup=$2 sit=$3 steps=${4:-20} width=${5:-860} play=${6:-}
root=$(git rev-parse --show-toplevel)
out=${OUT:-${TMPDIR:-/tmp}}
page="$root/.sim-shot.html"
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}

curl -sf -o /dev/null http://127.0.0.1:8090/ || { echo "start the server first: make serve" >&2; exit 1; }
trap 'rm -f "$page"' EXIT
cat > "$page" <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="css/style.css">
<style>body{max-width:820px;padding:16px}</style></head><body><div id="root"></div>
<script type="module">
const q = new URLSearchParams(location.search);
const { mount } = await import(`./scenarios/${q.get('id')}/sim.js`);
mount(document.getElementById('root'), { revealed: true, state: { setup: q.get('setup'), situation: q.get('sit') } });
setTimeout(() => {
  for (let i = 0; i < +q.get('n'); i++) document.querySelector('[title="Step"]').click();
  if (q.get('play')) document.querySelector('.tbtn.main').click();
}, 300);
</script></body></html>
EOF
file="$out/$id-$setup-$sit.png"
budget=$([ -n "$play" ] && echo 2300 || echo 3000)
"$chrome" --headless=new --disable-gpu --hide-scrollbars --window-size="$width,1000" \
  --virtual-time-budget="$budget" --screenshot="$file" \
  "http://127.0.0.1:8090/.sim-shot.html?id=$id&setup=$setup&sit=$sit&n=$steps&play=$play" 2>/dev/null
echo "$file"
