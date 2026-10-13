.PHONY: serve test new

# Serve on http://127.0.0.1:8090/ (ES modules need http://, not file://).
# Sends Cache-Control: no-cache so the browser never runs a stale module after an edit.
PORT ?= 8090
serve:
	python3 -c "import http.server as h; \
	H = type('H', (h.SimpleHTTPRequestHandler,), {'end_headers': lambda s: (s.send_header('Cache-Control', 'no-cache'), h.SimpleHTTPRequestHandler.end_headers(s))}); \
	h.ThreadingHTTPServer(('127.0.0.1', $(PORT)), H).serve_forever()"

test:
	node --test

# Start a scenario from the template:  make new ID=cache-stampede
new:
	@echo "$(ID)" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$$' || { echo "usage: make new ID=<kebab-case-id>"; exit 2; }
	@test ! -e scenarios/$(ID) || { echo "scenarios/$(ID) already exists"; exit 2; }
	cp -R scenarios/_template scenarios/$(ID)
	@echo "Created scenarios/$(ID). Now add '$(ID)' to scenarios/index.js where it belongs in the order."
