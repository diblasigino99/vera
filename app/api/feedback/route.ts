import { NextResponse } from "next/server";
import { z } from "zod";
import { recordFeedbackEvent } from "@/lib/server/feedback";

const FeedbackBody = z.object({
  searchQuery: z.string().trim().max(240).optional(),
  resultSlug: z.string().trim().max(320).optional(),
  feedbackType: z.enum(["yes", "no", "report_issue"]),
  feedbackText: z.string().trim().max(2000).optional(),
  evidenceType: z.string().trim().max(80).optional(),
  consensusClassification: z.string().trim().max(80).optional()
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
