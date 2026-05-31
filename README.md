# CompX Worker

Crawlee + Puppeteer + BullMQ deep scrape worker.

## Structure

```
worker/
├── src/
│   ├── index.js              # Main entry — BullMQ worker
│   ├── poller.js             # Supabase jobs table poller
│   └── jobs/
│       ├── enrichJob.js      # Website crawl + email extraction
│       ├── deepScrapeJob.js  # Puppeteer deep scrape (Maps, YP)
│       └── verifyEmailJob.js # SMTP email verification
├── .env.example
└── package.json
```

## Pipeline

```
Extension DOM scrape (seed)
        ↓
POST /api/jobs/create
        ↓
Supabase jobs table (pending)
        ↓
poller.js → BullMQ queue
        ↓
Worker processes job
  ├── enrichJob    → crawl website → extract email/phone/socials
  ├── deepScrapeJob → Puppeteer full scrape (Maps, YP)
  └── verifyEmailJob → SMTP check → update email_verified
        ↓
Supabase extension_database updated
        ↓
Dashboard shows enriched data
```

## Setup

```bash
cd worker
cp .env.example .env
# Fill in SUPABASE_SERVICE_ROLE_KEY and REDIS_URL

npm install
npm start
```

## Deploy options

### Option 1: Railway (easiest)
1. Push worker/ folder to GitHub
2. New project on railway.app
3. Add env vars
4. Deploy

### Option 2: Render
1. New Web Service on render.com
2. Build: `npm install`
3. Start: `node src/index.js`
4. Add env vars

### Option 3: Local (development)
```bash
# Start Redis
docker run -d -p 6379:6379 redis:alpine

# Start worker
npm run dev
```

## Redis options

- **Local**: `redis://localhost:6379`
- **Upstash** (serverless, free tier): https://upstash.com
- **Redis Cloud**: https://redis.com/try-free

## Job types

| Type | What it does |
|------|-------------|
| `enrich` | Crawl website, extract emails/phones/socials/tech stack |
| `deep_scrape` | Puppeteer full page scrape (Google Maps, Yellow Pages) |
| `verify_email` | SMTP handshake — valid/invalid/risky/catch-all |
