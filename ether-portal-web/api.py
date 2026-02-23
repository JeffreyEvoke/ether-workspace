#!/usr/bin/env python3
"""
Ether Portal API Server
Simple REST API that proxies to OpenClaw gateway internally.
No auth required - secured by Tailscale network.
"""

import json
import subprocess
import http.server
import socketserver
from urllib.parse import urlparse, parse_qs
import os

PORT = 8082

class APIHandler(http.server.BaseHTTPRequestHandler):
    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def run_openclaw(self, *args):
        """Run openclaw CLI command and return output"""
        try:
            result = subprocess.run(
                ['openclaw'] + list(args),
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, 'NO_COLOR': '1'}
            )
            return result.stdout, result.stderr, result.returncode
        except subprocess.TimeoutExpired:
            return '', 'Command timed out', 1
        except Exception as e:
            return '', str(e), 1

    def do_GET(self):
        path = urlparse(self.path).path

        if path == '/api/status':
            stdout, stderr, code = self.run_openclaw('status', '--json')
            try:
                data = json.loads(stdout) if stdout.strip() else {}
                self.send_json({'ok': True, 'status': data})
            except:
                self.send_json({'ok': True, 'status': {'raw': stdout or stderr}})

        elif path == '/api/jobs':
            stdout, stderr, code = self.run_openclaw('cron', 'list', '--json')
            try:
                data = json.loads(stdout) if stdout.strip() else {}
                # Handle both array and object responses
                if isinstance(data, list):
                    jobs = data
                else:
                    jobs = data.get('jobs', [])
                self.send_json({'ok': True, 'jobs': jobs})
            except:
                self.send_json({'ok': True, 'jobs': [], 'raw': stdout})

        elif path == '/api/sessions':
            stdout, stderr, code = self.run_openclaw('sessions', 'list', '--json')
            try:
                sessions = json.loads(stdout) if stdout.strip() else []
                self.send_json({'ok': True, 'sessions': sessions})
            except:
                self.send_json({'ok': True, 'sessions': [], 'raw': stdout})

        elif path == '/api/health':
            self.send_json({'ok': True, 'service': 'ether-portal-api'})

        else:
            self.send_json({'ok': False, 'error': 'Not found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode() if content_length > 0 else '{}'
        
        try:
            data = json.loads(body) if body else {}
        except:
            data = {}

        if path == '/api/message':
            message = data.get('message', '')
            if not message:
                self.send_json({'ok': False, 'error': 'Message required'}, 400)
                return
            # Send message to main session
            stdout, stderr, code = self.run_openclaw('sessions', 'send', '--message', message)
            self.send_json({'ok': code == 0, 'output': stdout or stderr})

        elif path == '/api/job/run':
            job_id = data.get('jobId', '')
            if not job_id:
                self.send_json({'ok': False, 'error': 'jobId required'}, 400)
                return
            stdout, stderr, code = self.run_openclaw('cron', 'run', job_id)
            self.send_json({'ok': code == 0, 'output': stdout or stderr})

        elif path == '/api/job/toggle':
            job_id = data.get('jobId', '')
            enabled = data.get('enabled', True)
            if not job_id:
                self.send_json({'ok': False, 'error': 'jobId required'}, 400)
                return
            action = 'enable' if enabled else 'disable'
            stdout, stderr, code = self.run_openclaw('cron', action, job_id)
            self.send_json({'ok': code == 0, 'output': stdout or stderr})

        else:
            self.send_json({'ok': False, 'error': 'Not found'}, 404)

    def log_message(self, format, *args):
        print(f"[API] {args[0]}")


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), APIHandler) as httpd:
        print(f"Ether Portal API running on http://0.0.0.0:{PORT}")
        httpd.serve_forever()
