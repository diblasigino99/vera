import { NextResponse } from "next/server";
import { z } from "zod";
import { recordContenderActionEvent } from "@/lib/server/action-events";

const ContenderActionBody = z.object({
  eventType: z.enum(["contender_action_impression", "contender_action_click"]),
  searchId: z.string().uuid().nullable().optional(),
  searchQuery: z.string().trim().max(240).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  consensusMode: z.string().trim().max(80).nullable().optional(),
  contenderName: z.string().trim().min(1).max(240),
  actionType: z.string().trim().min(1).max(80),
  displayPosition: z.number().int().min(1).max(100).nullable().optional(),
  destinationDomain: z.string().trim().min(1).max(240).nullable().optional()
});

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = ContenderActionBody.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Action event could not be recorded." }, { status: 400 });
  }

  await recordContenderActionEvent(body.data);

  return NextResponse.json({ ok: true });
}
