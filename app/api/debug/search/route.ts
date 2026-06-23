import { NextResponse } from "next/server";
import { analyzeConsensusWithDebug } from "@/lib/server/analyze";
import { cacheConsensus } from "@/lib/server/cache";
import { getLiveSearchSetup, liveSearchSetupMessage } from "@/lib/server/env";
import { searchPublicWeb } from "@/lib/server/search";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || "Best first date restaurant in Williamsburg";
  const setup = getLiveSearchSetup();

  if (!setup.ready) {
    return NextResponse.json(
      {
        ok: false,
        error: liveSearchSetupMessage(setup.missing),
        setup,
        debugUrl: "/api/debug/search?q=Best%20first%20date%20restaurant%20in%20Williamsburg"
      },
      { status: 503 }
    );
  }

  try {
    const tavilyResults = await searchPublicWeb(query);
    console.log("[vera:debug] Tavily search results returned", {
      query,
      count: tavilyResults.length,
      results: tavilyResults
    });

    const openAIAnalysis = await analyzeConsensusWithDebug(query, tavilyResults);
    console.log("[vera:debug] OpenAI analysis returned", {
      rawOpenAIContent: openAIAnalysis.rawOpenAIContent,
      parsedOpenAIAnalysis: openAIAnalysis.parsedOpenAIAnalysis
    });

    await cacheConsensus(openAIAnalysis.consensus);
    console.log("[vera:debug] Final Vera result JSON", openAIAnalysis.consensus);

    return NextResponse.json({
      ok: true,
      query,
      setup,
      tavilyResults,
      openAIAnalysis: {
        rawOpenAIContent: openAIAnalysis.rawOpenAIContent,
        parsedOpenAIAnalysis: openAIAnalysis.parsedOpenAIAnalysis
      },
      finalVeraResult: openAIAnalysis.consensus
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Debug search failed.";

    return NextResponse.json(
      {
        ok: false,
        query,
        setup,
        error: message
      },
      { status: 500 }
    );
  }
}
