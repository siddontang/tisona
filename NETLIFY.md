# Deploy the Console on Netlify

Netlify can host the Console and proxy its short browser API requests. The
complete service cannot run entirely on Netlify with the current architecture:
the Resonate Rust engine advances durable timers continuously, the Node gateway
exposes the authenticated protocol, and SDK workers hold outbound SSE connections.

Use this layout:

```text
Browser -> Netlify Console -> /session, /v1/* proxy -> TiSona gateway
Agent / customer worker --------------------------> TiSona gateway
                                                    |
                                               Resonate engine
                                                    |
                                                   TiDB
```

## 1. Host the backend

Follow [PRODUCTION.md](PRODUCTION.md) on an always-on Linux host. Use a persistent
TiDB database for a production deployment, or retain the expiry limitations of
Cloud Zero for a preview. Expose the gateway over HTTPS; keep engine and metrics
ports private. Set these gateway environment values:

```sh
RESONATE_PUBLIC_URL=https://api.example.com
RESONATE_CONSOLE_URL=https://your-project.netlify.app
```

`RESONATE_PUBLIC_URL` remains the API/worker endpoint. `RESONATE_CONSOLE_URL`
permits only that exact browser origin and directs execution links to the
Console. This does not enable wildcard CORS or anonymous production sign-in.
The gateway issues HttpOnly, Secure, SameSite=Strict cookies for the configured
separate Console origin; the Netlify proxy makes requests same-origin from
the browser's point of view. Credentials and database access stay on the backend.

## 2. Import the repository into Netlify

Import `siddontang/tisona` using your Netlify account. `netlify.toml` sets the
build command to `npm run build:console`, publish directory to `.netlify-dist`,
and Node version to 22. Set the build environment variable:

```text
TISONA_API_ORIGIN=https://api.example.com
```

This must be the reachable gateway origin, not localhost or the Netlify site.
The build refuses a missing API origin rather than publishing a broken Console.
Use the exact final Netlify/custom domain in the gateway's Console setting.
For a deploy preview, configure that preview's exact Console origin on a staging
gateway; production does not trust arbitrary Netlify preview domains.

The build copies public HTML/CSS/JavaScript only. It generates `/session` and
`/v1/*` proxy rewrites and browser security headers. It never copies `.local`,
keys, database URLs, Node dependencies or the vendored engine. No administrator
credential is placed in frontend code or Netlify build settings.

## 3. Verify

Open the deployed Console and sign in using its administrator credential.
Verify `/v1/project` reports `https://api.example.com` as its endpoint. Start
`npm run worker:examples` against that endpoint with a Worker API key, then
run an example from Overview. Confirm a created run, saved steps and final result.
Reload and verify the session and execution deep link still work. An untrusted
browser origin must continue to receive HTTP 403 from the gateway.

Workers and agents use the backend endpoint directly. Do not route SDK `POST /`
or `/poll/*` SSE traffic through Netlify: proxy requests time out after 26 seconds,
and Functions have bounded invocation lifetimes. The browser Console uses
asynchronous execution creation and status polling, which fit this split.

## Local build check

```sh
npm ci
npm test
TISONA_API_ORIGIN=https://api.example.com npm run build:console
```

The example API origin validates packaging only; replace it with a running backend
before deploying. A successful static build is not a working hosted execution
service. This repository does not provision a backend, create a Netlify project,
or grant Netlify access to GitHub automatically.

References: [Netlify proxy limitations](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/),
[Function limits](https://docs.netlify.com/build/functions/configuration/).
