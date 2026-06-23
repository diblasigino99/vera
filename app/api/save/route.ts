import { NextResponse } from "next/server";
import { z } from "zod";
import { getSavedState, saveResult, saveSearch } from "@/lib/server/cache";

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
    const message = error instanceof Error ? error.message : "Could not save.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const actorId = params.get("actorId");
  const searchId = params.get("searchId");
  const resultId = params.get("resultId") ?? undefined;

  const parsed = z
    .object({
      actorId: z.string().uuid(),
      searchId: z.string().min(1),
      resultId: z.string().optional()
    })
    .safeParse({ actorId, searchId, resultId });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid save status request." }, { status: 400 });
  }

  const state = await getSavedState(parsed.data.actorId, parsed.data.searchId, parsed.data.resultId);
  return NextResponse.json(state);
}
