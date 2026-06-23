# Vera

Vera is a clean search-first MVP for discovering what public web sources agree on for a specific decision.

## Product Flow

Search -> Consensus -> Learn Why -> Sources

Vera is not a chatbot, social network, dashboard, or feed. It uses live web search and OpenAI extraction, then caches completed searches.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env.local` and fill in:

```bash
OPENAI_API_KEY=
TAVILY_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

3. Run `supabase/schema.sql` in Supabase SQL editor.

4. Start the app:

```bash
npm run dev
```

## Live Search Debugging

Use this endpoint to inspect each live-search stage:

```text
/api/debug/search?q=Best%20first%20date%20restaurant%20in%20Williamsburg
```

It returns Tavily results, OpenAI's parsed analysis, and Vera's final result JSON. If `OPENAI_API_KEY` or `TAVILY_API_KEY` is missing, it returns a setup message instead.

## Data Honesty

Vera does not ship seed recommendations. If Tavily, OpenAI, or reliable evidence is missing, it says there is not enough reliable data instead of forcing a winner.
