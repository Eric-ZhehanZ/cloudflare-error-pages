// Edge origin tester
//
// A tiny origin server for provoking Cloudflare error pages on purpose. Put it
// behind Cloudflare like any normal origin. Paths on the main port trigger
// origin-side conditions; extra ports each misbehave in one specific way so an
// Origin Rule can route a test path to them.
//
// No dependencies. Node 18 or newer.

'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== '' ? process.env[name] : fallback);

const PORTS = {
  http: Number(env('PORT_HTTP', 8080)),
  https: Number(env('PORT_HTTPS', 8443)),
  garbage: Number(env('PORT_520', 8520)),
  stall: Number(env('PORT_522', 8522)),
  plainForTls: Number(env('PORT_525', 8525)),
  selfSigned: Number(env('PORT_526', 8526)),
  expired: Number(env('PORT_526_EXPIRED', 8527)),
};
const HOSTNAME = env('ORIGIN_HOSTNAME', 'origin-test.local');
const MAX_SLOW_SECONDS = Number(env('MAX_SLOW_SECONDS', 300));
const CERT_DIR = env('CERT_DIR', path.join(os.tmpdir(), 'edge-origin-tester-certs'));

// ---------------------------------------------------------------------------
// Certificates. A valid one for the main HTTPS port can be mounted (CERT_FILE
// and KEY_FILE). Self-signed and expired ones are generated at startup with
// openssl for the 526 ports.
// ---------------------------------------------------------------------------

function ensureCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const read = (name) => ({ key: fs.readFileSync(path.join(CERT_DIR, `${name}.key`)), cert: fs.readFileSync(path.join(CERT_DIR, `${name}.crt`)) });
  const have = (name) => fs.existsSync(path.join(CERT_DIR, `${name}.key`)) && fs.existsSync(path.join(CERT_DIR, `${name}.crt`));
  const run = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const subj = `/CN=${HOSTNAME}`;
  const san = `subjectAltName=DNS:${HOSTNAME}`;

  // Self-signed, valid for ten years.
  if (!have('self-signed')) {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', path.join(CERT_DIR, 'self-signed.key'), '-out', path.join(CERT_DIR, 'self-signed.crt'),
      '-subj', subj, '-addext', san]);
  }
  const selfSigned = read('self-signed');

  // Expired: issued by a throwaway CA with explicit dates in the past, since
  // `openssl req` cannot set dates. If anything goes wrong, fall back to the
  // self-signed certificate, which the edge distrusts just the same.
  let expired = selfSigned;
  try {
    if (!have('expired')) {
      const caDir = path.join(CERT_DIR, 'ca');
      fs.mkdirSync(caDir, { recursive: true });
      fs.writeFileSync(path.join(caDir, 'index.txt'), '');
      fs.writeFileSync(path.join(caDir, 'serial'), '01\n');
      fs.writeFileSync(path.join(caDir, 'ca.cnf'), [
        '[ ca ]', 'default_ca = ca_default',
        '[ ca_default ]', `dir = ${caDir}`, 'database = $dir/index.txt', 'new_certs_dir = $dir', 'serial = $dir/serial',
        'default_md = sha256', 'policy = policy_any', 'x509_extensions = v3_ext', 'unique_subject = no',
        '[ policy_any ]', 'commonName = supplied',
        '[ v3_ext ]', san, 'basicConstraints = CA:FALSE',
        '[ req ]', 'distinguished_name = dn', 'prompt = no',
        '[ dn ]', `CN = ${HOSTNAME}`,
      ].join('\n') + '\n');
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-keyout', path.join(caDir, 'ca.key'), '-out', path.join(caDir, 'ca.crt'), '-subj', '/CN=edge-origin-tester throwaway CA']);
      run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
        '-keyout', path.join(CERT_DIR, 'expired.key'), '-out', path.join(caDir, 'expired.csr'), '-subj', subj]);
      run(['ca', '-batch', '-config', path.join(caDir, 'ca.cnf'), '-keyfile', path.join(caDir, 'ca.key'), '-cert', path.join(caDir, 'ca.crt'),
        '-in', path.join(caDir, 'expired.csr'), '-out', path.join(CERT_DIR, 'expired.crt'), '-notext',
        '-startdate', '20200101000000Z', '-enddate', '20200102000000Z']);
    }
    expired = read('expired');
  } catch (err) {
    console.warn(`[certs] could not create the expired certificate, using the self-signed one instead. ${err.stderr ? String(err.stderr).trim() : err.message}`);
  }
  return { selfSigned, expired };
}

function mainTlsOptions(generated) {
  const certFile = env('CERT_FILE', '');
  const keyFile = env('KEY_FILE', '');
  if (certFile && keyFile) return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  return generated.selfSigned;
}

// ---------------------------------------------------------------------------
// The main request handler (same on the HTTP and HTTPS ports).
// ---------------------------------------------------------------------------

const TESTS = [
  {
    group: 'Origin conditions on this port',
    items: [
      ['/status/500', 'Answer 500 with an empty body. Any 200 to 599 works, for example /status/502, /status/503, /status/504, /status/429.'],
      ['/status/500?body=1', 'Same, with a short text body.'],
      ['/slow/110', 'Wait 110 seconds before answering. Above the edge limit of 100 seconds this gives 524. Try /slow/30 for a slow but successful answer.'],
      ['/reset', 'Accept the request, then close the connection without answering. Expect 520.'],
      ['/garbage', 'Answer with bytes that are not HTTP. Expect 520.'],
      ['/big-headers', 'Answer 200 with about 40 KB of response headers, over the edge limit. Expect 520.'],
      ['/echo', 'Answer 200 and show the request headers, so you can confirm the request came through the edge.'],
      ['/health', 'Answer 200 ok.'],
    ],
  },
  {
    group: 'Ports that misbehave (route a path to them with an Origin Rule)',
    items: [
      [`:${PORTS.garbage}`, 'Every connection gets non-HTTP bytes. Expect 520.'],
      [`:${PORTS.stall}`, 'Accepts the connection and never answers. Over https expect 525 after the handshake times out; over http expect 524.'],
      [`:${PORTS.plainForTls}`, 'Speaks plain HTTP. Route an https request here and the TLS handshake fails. Expect 525.'],
      [`:${PORTS.selfSigned}`, 'HTTPS with a self-signed certificate. Expect 526 under SSL mode Full (strict).'],
      [`:${PORTS.expired}`, 'HTTPS with an expired certificate. Expect 526 under SSL mode Full (strict).'],
      [':8521', 'Nothing listens here. Expect 521.'],
      ['(firewalled port)', 'A port your firewall silently drops. Expect 522. See the README.'],
    ],
  },
  {
    group: 'Paths that need a rule on the zone (this origin answers 200)',
    items: [
      ['/rule/block', 'WAF custom rule, action Block.'],
      ['/rule/managed', 'WAF custom rule, action Managed Challenge.'],
      ['/rule/interactive', 'WAF custom rule, action Interactive Challenge.'],
      ['/rule/js', 'WAF custom rule, action JS Challenge.'],
      ['/rule/rate-limit', 'Rate limiting rule with a low threshold. Reload a few times.'],
      ['/rule/ip', 'IP access rule blocking your own address.'],
      ['/rule/country', 'Rule blocking your country.'],
    ],
  },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const baseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = body === null ? null : Buffer.from(body);
  const headers = { ...baseHeaders, ...extra };
  if (buf) {
    headers['Content-Type'] = type;
    headers['Content-Length'] = String(buf.length);
  } else {
    headers['Content-Length'] = '0';
  }
  res.writeHead(status, headers);
  res.end(buf || undefined);
}

function indexPage(req) {
  const sections = TESTS.map(({ group, items }) => `
  <h2>${esc(group)}</h2>
  <ul>${items.map(([target, what]) => {
    const isPath = target.startsWith('/');
    const label = isPath ? `<a href="${esc(target)}">${esc(target)}</a>` : `<code>${esc(target)}</code>`;
    return `\n    <li>${label}<br><small>${esc(what)}</small></li>`;
  }).join('')}
  </ul>`).join('');
  const via = req.headers['cf-ray'] ? `Request came through the edge (cf-ray ${esc(req.headers['cf-ray'])}).` : 'Request did not come through the edge (no cf-ray header).';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edge origin tester</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; color: #1c1917; background: #f5f5f4; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 2rem; }
  ul { padding-left: 1.25rem; } li { margin: .5rem 0; } small { color: #666; } code { font-size: .95em; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f4; background: #1c1917; } small { color: #aaa; } }
</style>
</head>
<body>
<h1>Edge origin tester</h1>
<p>${via}</p>
<p>Each item provokes one condition on purpose. Open a link in a normal tab and see which page the edge serves.</p>
${sections}
</body>
</html>
`;
}

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;

  if (p === '/' || p === '/index.html') return send(res, 200, indexPage(req), 'text/html; charset=utf-8');
  if (p === '/health') return send(res, 200, 'ok\n');
  if (p === '/favicon.ico') return send(res, 404, null);

  if (p === '/echo') {
    const lines = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    return send(res, 200, `${req.method} ${req.url}\nremote ${req.socket.remoteAddress}\n\n${lines.join('\n')}\n`);
  }

  if ((m = p.match(/^\/status\/(\d{3})$/))) {
    const status = Number(m[1]);
    if (status < 200 || status > 599) return send(res, 400, 'Status must be 200 to 599\n');
    const body = url.searchParams.has('body') ? `Origin answered ${status} on purpose.\n` : null;
    return send(res, status, body);
  }

  if ((m = p.match(/^\/slow\/(\d{1,4})$/))) {
    const seconds = Math.min(Number(m[1]), MAX_SLOW_SECONDS);
    const timer = setTimeout(() => send(res, 200, `Answered after ${seconds} seconds.\n`), seconds * 1000);
    req.on('close', () => clearTimeout(timer));
    return undefined;
  }

  if (p === '/reset') {
    req.socket.destroy();
    return undefined;
  }

  if (p === '/garbage') {
    req.socket.write('this is not an http response\r\n\r\n');
    req.socket.destroy();
    return undefined;
  }

  if (p === '/big-headers') {
    const extra = {};
    for (let i = 0; i < 40; i++) extra[`X-Padding-${i}`] = 'x'.repeat(1000);
    return send(res, 200, 'Big headers sent.\n', 'text/plain; charset=utf-8', extra);
  }

  if ((m = p.match(/^\/rule\/([a-z-]+)$/))) {
    return send(res, 200, `No rule fired for /rule/${m[1]}. The origin answered normally, so the edge let this request through.\n`);
  }

  return send(res, 404, 'Not a test path. Open / for the index.\n');
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

function listen(server, port, label) {
  server.on('error', (err) => { console.error(`[${label}] cannot listen on ${port}. ${err.message}`); });
  server.listen(port, '0.0.0.0', () => console.log(`[${label}] listening on ${port}`));
}

const certs = ensureCerts();

// Main origin, HTTP and HTTPS.
listen(http.createServer(handle), PORTS.http, 'http');
listen(https.createServer(mainTlsOptions(certs), handle), PORTS.https, 'https');

// 520: every connection gets bytes that are not HTTP.
listen(net.createServer((socket) => {
  socket.write('this is not an http response\r\n\r\n');
  socket.destroy();
}), PORTS.garbage, '520 garbage');

// Stall: accept and never answer.
listen(net.createServer((socket) => {
  socket.on('error', () => {});
  socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
}), PORTS.stall, 'stall');

// 525: plain HTTP on a port that the edge will be told to reach over TLS.
listen(http.createServer(handle), PORTS.plainForTls, '525 plain');

// 526: TLS with certificates the edge will not trust in Full (strict) mode.
listen(https.createServer(certs.selfSigned, handle), PORTS.selfSigned, '526 self-signed');
listen(https.createServer(certs.expired, handle), PORTS.expired, '526 expired');

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
