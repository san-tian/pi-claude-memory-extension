#!/usr/bin/env python3
import gzip
import http.server
import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

UPSTREAM = os.environ.get('UPSTREAM', '').rstrip('/')
if not UPSTREAM:
    raise SystemExit('Set UPSTREAM to your OpenAI-compatible base URL, for example UPSTREAM=https://api.example.com/openai/v1')

LOG_DIR = Path(os.environ.get('LOG_DIR', '.tmp/codex-proxy-logs'))
LOG_DIR.mkdir(parents=True, exist_ok=True)
counter = 0
lock = threading.Lock()
inject_overflow_once = os.environ.get('INJECT_FIRST_RESPONSES_OVERFLOW', '0') == '1'
injected = False


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_POST(self):
        global counter, injected
        length = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(length)
        with lock:
            counter += 1
            idx = counter
        stem = self.path.strip('/').replace('/', '_') or 'root'
        try:
            body_json = json.loads(body.decode('utf-8')) if body else None
        except Exception:
            body_json = {'raw': body.decode('utf-8', 'replace')}
        (LOG_DIR / f'{idx:03d}-{stem}.request.json').write_text(json.dumps({
            'path': self.path,
            'headers': {k: v for k, v in self.headers.items()},
            'body': body_json,
        }, ensure_ascii=False, indent=2))

        if inject_overflow_once and not injected and self.path == '/responses':
            injected = True
            payload = {
                'error': {
                    'message': 'context_length_exceeded: simulated overflow from local proxy',
                    'type': 'invalid_request_error',
                    'param': 'input',
                    'code': 'context_length_exceeded',
                },
                'type': 'error',
            }
            data = json.dumps(payload).encode('utf-8')
            status = 400
            headers = {'Content-Type': 'application/json; charset=utf-8'}
            (LOG_DIR / f'{idx:03d}-{stem}.response.json').write_text(json.dumps({'status': status, 'headers': headers, 'body': payload}, ensure_ascii=False, indent=2))
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)
            return

        req = urllib.request.Request(UPSTREAM + self.path, data=body, method='POST')
        for k, v in self.headers.items():
            if k.lower() in {'host', 'content-length', 'connection'}:
                continue
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = resp.read()
                status = resp.status
                headers = dict(resp.headers.items())
        except urllib.error.HTTPError as error:
            data = error.read()
            status = error.code
            headers = dict(error.headers.items())

        if headers.get('content-encoding', '').lower() == 'gzip':
            try:
                data = gzip.decompress(data)
                headers.pop('content-encoding', None)
            except Exception:
                pass

        try:
            payload = json.loads(data.decode('utf-8'))
        except Exception:
            payload = {'raw': data.decode('utf-8', 'replace')}
        (LOG_DIR / f'{idx:03d}-{stem}.response.json').write_text(json.dumps({'status': status, 'headers': headers, 'body': payload}, ensure_ascii=False, indent=2))
        self.send_response(status)
        for k, v in headers.items():
            if k.lower() in {'transfer-encoding', 'connection', 'content-encoding', 'content-length'}:
                continue
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        return


if __name__ == '__main__':
    import socketserver

    port = int(os.environ.get('PORT', '8787'))
    with socketserver.TCPServer(('127.0.0.1', port), Handler) as httpd:
        print(f'proxy listening on {port}', flush=True)
        httpd.serve_forever()
