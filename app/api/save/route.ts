import { NextResponse } from "next/server";
import { z } from "zod";
import { getSavedState, getSavedStateBatch, saveResult, saveSearch } from "@/lib/server/cache";

const SaveBody = z.object({
  kind: z.enum(["search", "result"]),
  searchId: z.string().min(1),
  resultId: z.string().optional(),
  actorId: z.string().uuid()
});

export async function POST(request: Request) {
  const body = SaveBody.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Invalid save request." }, { status: 400 });
  }

  try {
    if (body.data.kind === "search") {
      await saveSearch(body.data.searchId, body.data.actorId);
    } else {
      if (!body.data.resultId) {
        return NextResponse.json({ error: "Missing result id." }, { status: 400 });
      }

      await saveResult(body.data.searchId, body.data.resultId, body.data.actorId);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[vera:save] save failed", {
      kind: body.data.kind,
      searchId: body.data.searchId,
      resultId: body.data.resultId ?? null,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });
    return NextResponse.json({ error: "Vera couldn't save this yet. Please try again." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const actorId = params.get("actorId");
  const searchId = params.get("searchId");
  const resultId = params.get("resultId") ?? undefined;
  const resultIds = params.get("resultIds") ?? undefined;

  const parsed = z
    .object({
      actorId: z.string().uuid(),
      searchId: z.string().min(1),
      resultId: z.string().optional(),
      resultIds: z.string().optional()
    })
    .safeParse({ actorId, searchId, resultId, resultIds });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid save status request." }, { status: 400 });
  }

  if (parsed.data.resultIds) {
    const ids = parsed.data.resultIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    console.log("SAVE_STATUS_BATCH_FETCH", {
      searchId: parsed.data.searchId,
      resultCount: ids.length
    });

    const state = await getSavedStateBatch(parsed.data.actorId, parsed.data.searchId, ids);
    return NextResponse.json(state);
  }

  const state = await getSavedState(parsed.data.actorId, parsed.data.searchId, parsed.data.resultId);
  return NextResponse.json(state);
}
