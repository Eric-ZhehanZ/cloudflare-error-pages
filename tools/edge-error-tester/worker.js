/**
 * Edge error tester
 *
 * A small Cloudflare Worker that lets you trigger each custom page on purpose
 * from a different path. Deploy it on a route of the zone that serves the
 * custom pages (for example test.zheha.nz/*) and open / for the index.
 *
 * Two kinds of test path:
 *
 *  1. Paths the Worker answers itself. It returns a chosen status, waits for a
 *     chosen time, or proxies a deliberately broken origin so the edge produces
 *     a 52x. Which of these Cloudflare replaces with the custom 5xx page depends
 *     on the zone's Custom Errors / Error Rules settings, so hit each one and
 *     look at what comes back.
 *
 *  2. Paths the Worker answers with a plain 200. Each one is meant to be matched
 *     by a WAF custom rule, a rate limiting rule, or an IP access rule with the
 *     action you want to test. If you see the 200 text, the rule did not fire.
 *     The README lists the rule expressions.
 *
 * Every response carries X-Robots-Tag: noindex.
 */

const TESTS = [
  {
    group: 'Answered by the Worker',
    items: [
      ['/status/500', 'Origin returns 500 with an empty body'],
      ['/status/502', 'Origin returns 502 with an empty body'],
      ['/status/503', 'Origin returns 503 with an empty body'],
      ['/status/504', 'Origin returns 504 with an empty body'],
      ['/status/500?body=text', 'Origin returns 500 with a short text body'],
      ['/status/429', 'Origin returns 429 with an empty body'],
      ['/slow/30', 'Origin waits 30 seconds before answering (up to /slow/120)'],
      ['/origin/timeout', 'Proxy to an unroutable address (expect 522)'],
      ['/origin/refused', 'Proxy to a closed port (expect 521)'],
      ['/origin/expired-tls', 'Proxy to a host with an expired certificate (expect 526)'],
      ['/origin/self-signed', 'Proxy to a host with a self-signed certificate (expect 526)'],
      ['/origin/wrong-host', 'Proxy to a host whose certificate does not match (expect 526)'],
      ['/origin/timeout?raw=1', 'Same, but pass the subrequest body through instead of an empty body'],
    ],
  },
  {
    group: 'Needs a rule on the zone (Worker answers 200)',
    items: [
      ['/rule/block', 'WAF custom rule, action Block'],
      ['/rule/managed', 'WAF custom rule, action Managed Challenge'],
      ['/rule/interactive', 'WAF custom rule, action Interactive Challenge'],
      ['/rule/js', 'WAF custom rule, action JS Challenge'],
      ['/rule/rate-limit', 'Rate limiting rule, low threshold (reload a few times)'],
      ['/rule/ip', 'IP access rule blocking your own address (1006)'],
      ['/rule/country', 'IP access rule or WAF rule blocking your country'],
    ],
  },
];

// Deliberately broken origins for the 52x tests.
const BROKEN_ORIGINS = {
  timeout: 'http://203.0.113.1/',            // TEST-NET-3, never routed
  refused: 'http://portquiz.net:81/',        // host answers on 80 only
  'expired-tls': 'https://expired.badssl.com/',
  'self-signed': 'https://self-signed.badssl.com/',
  'wrong-host': 'https://wrong.host.badssl.com/',
};

const NOINDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NOINDEX } });

const text = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NOINDEX } });

function indexPage(base) {
  const sections = TESTS.map(({ group, items }) => `
    <h2>${group}</h2>
    <ul>${items.map(([path, what]) => `
      <li><a href="${base}${path}">${base}${path}</a><br><small>${what}</small></li>`).join('')}
    </ul>`).join('');
  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edge error tester</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; color: #1c1917; background: #f5f5f4; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 2rem; }
  ul { padding-left: 1.25rem; } li { margin: .5rem 0; } small { color: #666; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f4; background: #1c1917; } small { color: #aaa; } }
</style>
</head>
<body>
<h1>Edge error tester</h1>
<p>Each link triggers one condition on purpose. Open it in a normal tab and check which page the edge serves.</p>
${sections}
</body>
</html>`);
}

async function proxyBrokenOrigin(kind, raw) {
  const target = BROKEN_ORIGINS[kind];
  if (!target) return text('Unknown origin test', 404);
  let upstream;
  try {
    upstream = await fetch(target, { redirect: 'manual', cf: { cacheTtl: 0 } });
  } catch (err) {
    // The runtime threw instead of handing back a 52x. Report it as a 502 so
    // the edge still has an error status to act on.
    return text(`Subrequest failed. ${err && err.message ? err.message : err}`, 502);
  }
  if (raw) {
    const headers = new Headers(upstream.headers);
    Object.entries(NOINDEX).forEach(([k, v]) => headers.set(k, v));
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  return new Response(null, { status: upstream.status, headers: NOINDEX });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = (env && env.PATH_PREFIX ? env.PATH_PREFIX : '').replace(/\/$/, '');
    let path = url.pathname;
    if (base && path.startsWith(base)) path = path.slice(base.length) || '/';

    if (path === '/' || path === '') return indexPage(base);

    let m;
    if ((m = path.match(/^\/status\/(\d{3})$/))) {
      const status = Number(m[1]);
      if (status < 200 || status > 599) return text('Status must be 200 to 599', 400);
      const body = url.searchParams.get('body') === 'text' ? `Origin answered ${status} on purpose.` : null;
      return new Response(body, { status, headers: body ? { 'Content-Type': 'text/plain; charset=utf-8', ...NOINDEX } : NOINDEX });
    }

    if ((m = path.match(/^\/slow\/(\d{1,3})$/))) {
      const seconds = Math.min(Number(m[1]), 120);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return text(`Answered after ${seconds} seconds.`);
    }

    if ((m = path.match(/^\/origin\/([a-z-]+)$/))) {
      return proxyBrokenOrigin(m[1], url.searchParams.get('raw') === '1');
    }

    if ((m = path.match(/^\/rule\/([a-z-]+)$/))) {
      return text(`No rule fired for /rule/${m[1]}. The Worker answered normally, so the edge let this request through.`);
    }

    return text('Not a test path. Open / for the index.', 404);
  },
};
