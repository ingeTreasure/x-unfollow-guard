"""Serve the production popup with an isolated Chrome API fixture at /preview.
No fixture code is included by the extension or in the release archive.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
ROOT = Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def do_GET(self):
        if urlsplit(self.path).path == '/preview':
            source = (ROOT / 'popup/popup.html').read_text().replace('<head>', '<head><base href="/popup/">').replace('<script src="popup.js">', '<script src="/tests/chrome-mock.js"></script><script src="popup.js">')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(source.encode())
        else:
            super().do_GET()
if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
