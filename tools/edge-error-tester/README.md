# Edge error tester

A Cloudflare Worker for provoking each custom page on purpose, one path each.

## Deploy

```
cd tools/edge-error-tester
npx wrangler login
npx wrangler deploy
```

`wrangler.jsonc` routes it to `test.zheha.nz/*`. Change the route (or set
`PATH_PREFIX` and use a path route such as `zheha.nz/_edge-test/*`) to suit.
The hostname must be proxied through the same zone that has the custom pages,
otherwise the edge will not answer with them.

Open `/` on the deployed hostname for a clickable index of every test.

## Paths the Worker answers itself

| Path | What it does |
| --- | --- |
| `/status/500` `/status/502` `/status/503` `/status/504` `/status/429` | Returns that status with an empty body. Add `?body=text` for a short text body. |
| `/slow/30` | Waits that many seconds before answering, up to 120. |
| `/origin/timeout` | Proxies to an unroutable address, so the edge should produce 522. |
| `/origin/refused` | Proxies to a closed port, so the edge should produce 521. |
| `/origin/expired-tls` `/origin/self-signed` `/origin/wrong-host` | Proxies to badssl.com hosts with bad certificates, so the edge should produce 526. |

The `/origin/*` paths pass only the status through with an empty body. Add
`?raw=1` to pass the subrequest body through as well.

Whether the edge swaps in the custom 5xx page for a status returned by a Worker
depends on the zone's Custom Errors / Error Rules configuration. Hit each path
and see what comes back. Statuses the zone does not override are shown as the
plain response.

## Paths that need a rule on the zone

The Worker answers these with a plain 200 that says no rule fired. Create the
rules so that the edge acts before the Worker does.

| Path | Rule to create | Page it should show |
| --- | --- | --- |
| `/rule/block` | WAF custom rule, expression `http.request.uri.path eq "/rule/block"`, action Block | waf.html |
| `/rule/managed` | Same expression pattern, action Managed Challenge | auto.html |
| `/rule/interactive` | Same expression pattern, action Interactive Challenge | captcha.html |
| `/rule/js` | Same expression pattern, action JS Challenge | auto.html, non-interactive view |
| `/rule/rate-limit` | Rate limiting rule on that path, for example 3 requests per 10 seconds, action Block | err429.html |
| `/rule/ip` | IP access rule blocking your own address, then visit this path | ip.html |
| `/rule/country` | WAF custom rule `http.request.uri.path eq "/rule/country" and ip.src.country eq "XX"` with your country, action Block, or an IP access rule for the country | region.html |

Remove or disable the rules when you are done. The `/rule/ip` test in
particular blocks you from the whole zone until the access rule is deleted.

Every response from the Worker carries `X-Robots-Tag: noindex, nofollow`.
