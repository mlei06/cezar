#!/usr/bin/env python3
"""Fixed-destination TLS relay for the self-hosted model endpoint (host, port and CA bundle from
~/.config/factory-overseer.json). OpenCode's standalone binary ignores
custom CA settings, so it can't verify the endpoint's internal certificate. This listens on 127.0.0.1 only
and forwards every request to the configured endpoint, verifying its certificate against the configured
CA bundle, and streams the response back (server-sent events included)."""
import http.client, ssl, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import overseer_config as oc
_C = oc.load()
HOST, PORT = _C['endpoint']['host'], int(_C['endpoint']['port'])
LISTEN = ('127.0.0.1', int(_C.get('relayPort', 5001)))
CA = _C['caBundle']
CTX = ssl.create_default_context(cafile=CA)
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length'}


class Relay(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _forward(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        if body is not None:
            headers['Content-Length'] = str(len(body))
        conn = http.client.HTTPSConnection(HOST, PORT, context=CTX, timeout=900)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.send_header('Transfer-Encoding', 'chunked')
            self.send_header('Connection', 'close')
            self.end_headers()
            while True:
                chunk = resp.read1(65536) if hasattr(resp, 'read1') else resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(f'{len(chunk):X}\r\n'.encode() + chunk + b'\r\n')
                self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
        except Exception as e:
            try:
                self.send_error(502, f'relay: {e}')
            except Exception:
                pass
        finally:
            conn.close()
            self.close_connection = True

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _forward

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(LISTEN, Relay).serve_forever()
