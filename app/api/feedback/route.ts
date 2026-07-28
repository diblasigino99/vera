import { NextResponse } from "next/server";
import { z } from "zod";
import { recordFeedbackEvent } from "@/lib/server/feedback";

const FeedbackBody = z.object({
  searchId: z.string().uuid().optional(),
  actorId: z.string().trim().max(120).optional(),
  searchQuery: z.string().trim().max(240).optional(),
  resultSlug: z.string().trim().max(320).optional(),
  feedbackType: z.enum(["yes", "no", "report_issue"]),
  helpful: z.boolean().optional(),
  feedbackReason: z.enum(["wrong_recommendations", "missing_obvious", "unconvincing_sources", "misunderstood_search", "other"]).optional(),
  feedbackText: z.string().trim().max(2000).optional(),
  evidenceType: z.string().trim().max(80).optional(),
  consensusClassification: z.string().trim().max(80).optional(),
  displayedContenders: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
  cacheVersion: z.number().int().nonnegative().optional(),
  engineVersion: z.string().trim().max(80).optional()
});

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = FeedbackBody.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Feedback could not be submitted." }, { status: 400 });
  }

  try {
    await recordFeedbackEvent(body.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.warn("[vera:feedback] submission failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });

    return NextResponse.json({ error: "Feedback could not be submitted. Please try again." }, { status: 500 });
  }
}
