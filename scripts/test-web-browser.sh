#!/usr/bin/env bash
# Runs the web tests that need a real browser — the viewer component draws on a canvas
# and lays out a toolbar, and Node has no DOM — in headless Chrome at a device pixel ratio
# of 2. Build web/dist and web-ai/dist first (npm run build in each). WebMCP is a Blink
# feature behind a flag, enabled here so the agent tools can be registered for real.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "browser tests: Chrome not found at $CHROME (set CHROME)" >&2; exit 1; }

work=$(mktemp -d)
cat > "$work/server.py" <<'PY'
import http.server, sys
result = sys.argv[1]
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        with open(result, "wb") as f:
            f.write(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(204); self.end_headers()
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
PY
python3 "$work/server.py" "$work/result" > "$work/port" &
server=$!
# Chrome may still be writing its profile as it exits, so the directory is removed
# best-effort: a leftover temp directory must not fail a passing run.
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null || true; pkill -f "user-data-dir=$work/profile" 2>/dev/null; sleep 1; rm -rf "$work" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do [ -s "$work/port" ] && break; sleep 0.2; done

# The page posts its report when it finishes. Headless Chrome is not relied on to exit.
"$CHROME" --headless=new --disable-gpu --enable-blink-features=WebMCP --user-data-dir="$work/profile" --force-device-scale-factor=2 \
    --window-size=800,800 "http://127.0.0.1:$(cat "$work/port")/web/test-browser/viewer-element.html" \
    > /dev/null 2>&1 &
# The first run after a rebuild has twice produced no result within 60 s; 120 s has not failed.
for _ in $(seq 1 120); do [ -s "$work/result" ] && break; sleep 1; done

[ -s "$work/result" ] || { echo "browser tests: no result within 120 s" >&2; exit 1; }
cat "$work/result"; echo
grep -q '^PASS' "$work/result"
