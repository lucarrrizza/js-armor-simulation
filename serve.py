#!/usr/bin/env python3
"""Local server for Impact Sandbox.

The multi-core (Rust/WASM) engine needs SharedArrayBuffer, which browsers only
enable on cross-origin-isolated pages, so this adds the COOP/COEP headers.

    python3 serve.py [port] [--engine gpu|wasm|js] [--open]
"""
import argparse
import http.server
import os
import webbrowser


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('port', nargs='?', type=int, default=8000)
    ap.add_argument('--engine', choices=['gpu', 'wasm', 'js'])
    ap.add_argument('--open', action='store_true', help='open in the default browser')
    args = ap.parse_args()

    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://localhost:{args.port}/' + (f'?engine={args.engine}' if args.engine else '')
    print(f'Impact Sandbox running at {url}  (Ctrl+C to stop)')
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
