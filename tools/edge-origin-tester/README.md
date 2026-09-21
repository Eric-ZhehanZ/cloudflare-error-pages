# Edge origin tester

A small origin server, one file and no dependencies, that provokes Cloudflare
error pages on purpose. Run it in a container on any server, put Cloudflare in
front of it like a normal origin, then open the test paths.

## Run it

```
cd tools/edge-origin-tester
docker compose up -d --build
```

Or without compose:

```
docker build -t edge-origin-tester .
docker run -d --name edge-origin-tester --restart unless-stopped \
  -p 8080:8080 -p 8443:8443 -p 8520:8520 -p 8522:8522 -p 8525:8525 -p 8526:8526 -p 8527:8527 \
  -e ORIGIN_HOSTNAME=origin-test.zheha.nz edge-origin-tester
```

Or straight on a host that has Node 18+ and openssl:

```
ORIGIN_HOSTNAME=origin-test.zheha.nz node server.js
```

Open `http://<server>:8080/` directly first. The page says whether the request
came through the edge, and lists every test.

## Put Cloudflare in front

1. Add a proxied DNS record, for example `origin-test.zheha.nz`, pointing at
   the server.
2. Pick an SSL mode for that hostname. Two options.
   - **Full (strict)** with a certificate the edge trusts on port 8443. Mount a
     Cloudflare Origin CA certificate and set `CERT_FILE` and `KEY_FILE` in
     `docker-compose.yml`. This mode is needed for the 526 tests.
   - **Full** works with the built-in self-signed certificate on 8443, but the
     526 ports will then load normally instead of failing.
   Set the mode per hostname with a Configuration Rule if the rest of the zone
   uses something else.
3. Since the origin listens on non-standard ports, add an Origin Rule for the
   hostname that rewrites the destination port to 8443 (or 8080 with SSL mode
   Off or Flexible).
4. Add one Origin Rule per misbehaving port, matched on path, so a single
   hostname can reach all of them. Example expressions, each with the action
   "Destination port":

   | Path expression | Port | Expect |
   | --- | --- | --- |
   | `http.request.uri.path eq "/port/520"` | 8520 | 520 |
   | `http.request.uri.path eq "/port/521"` | 8521 | 521 (nothing listens there) |
   | `http.request.uri.path eq "/port/522"` | a port your firewall drops | 522 |
   | `http.request.uri.path eq "/port/stall"` | 8522 | 525 over https, 524 over http |
   | `http.request.uri.path eq "/port/525"` | 8525 | 525 |
   | `http.request.uri.path eq "/port/526"` | 8526 | 526 under Full (strict) |
   | `http.request.uri.path eq "/port/526-expired"` | 8527 | 526 under Full (strict) |

   For 522 the connection attempt must go unanswered, so drop the packets
   rather than reject them. On a Linux host, for example
   `iptables -I INPUT -p tcp --dport 8523 -j DROP`, and route `/port/522` to
   8523. A cloud firewall that has no rule for the port does the same thing.

## Paths on the main port

| Path | Result |
| --- | --- |
| `/status/500` and any `/status/NNN` from 200 to 599 | That status with an empty body. Add `?body=1` for a short text body. Whether the edge replaces an origin 5xx with the custom page depends on the zone's Custom Errors or Error Rules settings, so try and see. |
| `/slow/110` | Answers after 110 seconds, past the edge's 100 second limit, so 524. `/slow/30` answers late but successfully. |
| `/reset` | Closes the connection without answering. 520. |
| `/garbage` | Sends bytes that are not HTTP. 520. |
| `/big-headers` | Sends about 40 KB of response headers. 520. |
| `/echo` | Shows the request headers. `cf-ray`, `cf-connecting-ip` and `cf-ipcountry` confirm the request came through the edge. |
| `/health` | `ok` |

## Paths that need a rule

The origin answers these with a plain 200 that says no rule fired. Create the
rules so the edge acts first.

| Path | Rule | Page it should show |
| --- | --- | --- |
| `/rule/block` | WAF custom rule, `http.request.uri.path eq "/rule/block"`, action Block | waf.html |
| `/rule/managed` | Same pattern, action Managed Challenge | auto.html |
| `/rule/interactive` | Same pattern, action Interactive Challenge | captcha.html |
| `/rule/js` | Same pattern, action JS Challenge | auto.html, non-interactive view |
| `/rule/rate-limit` | Rate limiting rule on the path, for example 3 requests per 10 seconds, action Block | err429.html |
| `/rule/ip` | IP access rule blocking your own address, then visit the path | ip.html |
| `/rule/country` | WAF custom rule `http.request.uri.path eq "/rule/country" and ip.src.country eq "XX"` with your country, action Block, or an IP access rule for the country | region.html |

Disable the rules when done. The `/rule/ip` one blocks you from the whole zone
until it is removed.

## Settings

All optional, as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORIGIN_HOSTNAME` | `origin-test.local` | Name put in the generated certificates. |
| `CERT_FILE`, `KEY_FILE` | unset | A trusted certificate and key for port 8443. |
| `PORT_HTTP`, `PORT_HTTPS`, `PORT_520`, `PORT_522`, `PORT_525`, `PORT_526`, `PORT_526_EXPIRED` | 8080, 8443, 8520, 8522, 8525, 8526, 8527 | Listening ports. |
| `MAX_SLOW_SECONDS` | 300 | Upper bound for `/slow/N`. |
| `CERT_DIR` | a temp folder | Where generated certificates are kept. |

Every response carries `X-Robots-Tag: noindex, nofollow` and `Cache-Control:
no-store`.
