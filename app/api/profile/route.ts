import { NextResponse } from "next/server";
import { z } from "zod";
import { getProfileSnapshot } from "@/lib/server/cache";

export async function GET(request: Request) {
  const actorId = new URL(request.url).searchParams.get("actorId");
  const parsed = z.string().uuid().safeParse(actorId);

  if (!parsed.success) {
    return NextResponse.json({ error: "Missing profile id." }, { status: 400 });
  }

  const snapshot = await getProfileSnapshot(parsed.data);
  return NextResponse.json(snapshot);
}
