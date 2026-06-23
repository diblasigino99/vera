import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeConsensus } from "@/lib/server/analyze";
import { cacheConsensus, getCachedConsensus } from "@/lib/server/cache";
import { getLiveSearchSetup, liveSearchSetupMessage } from "@/lib/server/env";
import { searchPublicWeb } from "@/lib/server/search";

const SearchBody = z.object({
  query: z.string().trim().min(3).max(240)
});

export async function POST(request: Request) {
  const body = SearchBody.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Enter a more specific search." }, { status: 400 });
  }

  const setup = getLiveSearchSetup();
  if (!setup.ready) {
    return NextResponse.json(
      {
        error: liveSearchSetupMessage(setup.missing),
        setup
      },
      { status: 503 }
    );
  }

  const cached = await getCachedConsensus(body.data.query);

  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const sources = await searchPublicWeb(body.data.query);
    console.log("[vera:search] Tavily results returned", {
      query: body.data.query,
      count: sources.length,
      urls: sources.map((source) => source.url)
    });
    const consensus = await analyzeConsensus(body.data.query, sources);
    console.log("[vera:search] OpenAI analysis returned", {
      query: body.data.query,
      mode: consensus.mode,
      results: consensus.results.map((result) => result.name)
    });
    await cacheConsensus(consensus);
    console.log("[vera:search] Final Vera result JSON", consensus);
    return NextResponse.json(consensus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vera could not complete this search.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
