// trust-proxy — Cloudflare Worker
// Routes:
//   POST /            → proxies the request body to the Anthropic Messages API
//                       (client supplies its own x-api-key header)
//   POST /fetch-page  → scrapes a listing URL via Firecrawl (handles Zillow's
//                       bot protection); falls back to a direct fetch if no
//                       FIRECRAWL_API_KEY secret is configured or Firecrawl fails
//
// Secrets:
//   FIRECRAWL_API_KEY — set with: npx wrangler secret put FIRECRAWL_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return json({ error: { message: 'POST only' } }, 405);
    }

    const { pathname } = new URL(request.url);
    if (pathname === '/fetch-page') {
      return fetchPage(request, env);
    }
    return proxyAnthropic(request);
  },
};

// ── Anthropic Messages API passthrough ─────────────────────────────
async function proxyAnthropic(request) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': request.headers.get('x-api-key') || '',
      'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
    },
    body: request.body,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Listing page fetch ──────────────────────────────────────────────
async function fetchPage(request, env) {
  let url;
  try {
    ({ url } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    return json({ error: 'A valid http(s) url is required' }, 400);
  }

  // Primary path: Firecrawl — renders JS and gets past listing-site bot walls
  if (env.FIRECRAWL_API_KEY) {
    try {
      const fc = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({
          url,
          formats: ['markdown'],
          onlyMainContent: true,
          proxy: 'auto',        // escalates to stealth proxy if the basic one is blocked
          maxAge: 3600000,      // accept a cached scrape up to 1h old (faster, cheaper)
        }),
      });
      const data = await fc.json();
      const markdown = data?.data?.markdown || '';
      const meta = data?.data?.metadata || {};
      if (fc.ok && data?.success && markdown.length > 200) {
        // Prepend the page title/description — Zillow packs price/beds/baths in there
        const header = [meta.title, meta.description].filter(Boolean).join('\n');
        return json({
          text: `${header}\n\n${markdown}`.trim(),
          source: 'firecrawl',
        });
      }
      console.warn('Firecrawl scrape unusable:', fc.status, JSON.stringify(data).slice(0, 300));
    } catch (e) {
      console.warn('Firecrawl scrape failed:', e.message);
    }
  }

  // Fallback: direct fetch (most listing sites block this — caller must detect)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return json({ text: text.slice(0, 20000), source: 'direct' });
  } catch (e) {
    return json({ text: '', source: 'none', error: e.message });
  }
}
