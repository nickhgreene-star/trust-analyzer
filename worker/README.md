# trust-proxy worker

Cloudflare Worker behind `https://trust-proxy.nick-h-greene.workers.dev`.

- `POST /` — proxies to the Anthropic Messages API (browser supplies the `x-api-key`)
- `POST /fetch-page` — scrapes a listing URL via Firecrawl (gets past Zillow's bot wall);
  falls back to a direct fetch if no Firecrawl key is configured

## Deploy (from this folder)

```sh
npx wrangler login                          # one-time: opens browser to authorize Cloudflare
npx wrangler secret put FIRECRAWL_API_KEY   # one-time: paste key from firecrawl.dev dashboard
npx wrangler deploy
```

Without the `FIRECRAWL_API_KEY` secret, `/fetch-page` falls back to a plain fetch,
which Zillow blocks — the app will then require a screenshot or pasted details.
