import { getSupabaseAdmin } from "@/lib/server/supabase";

const actionEventInsertTimeoutMs = 1000;

export type ContenderActionEventInput = {
  eventType: "contender_action_impression" | "contender_action_click";
  searchId?: string | null;
  searchQuery?: string | null;
  category?: string | null;
  consensusMode?: string | null;
  contenderName: string;
  actionType: string;
  displayPosition?: number | null;
  destinationDomain?: string | null;
};

export async function recordContenderActionEvent(event: ContenderActionEventInput) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return;
  }

  try {
    const { error } = await withActionEventTimeout(
      supabase.from("contender_action_events").insert({
        event_type: event.eventType,
        search_id: event.searchId ?? null,
        search_query: event.searchQuery ?? null,
        category: event.category ?? null,
        consensus_mode: event.consensusMode ?? null,
        contender_name: event.contenderName,
        action_type: event.actionType,
        display_position: event.displayPosition ?? null,
        destination_domain: event.destinationDomain ?? null
      })
    );

    if (error) {
      console.warn("[vera:contender-actions] insert failed", {
        eventType: event.eventType,
        contenderName: event.contenderName,
        error: error.message,
        code: error.code ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null
      });
    }
  } catch (error) {
    console.warn("[vera:contender-actions] insert exception", {
      eventType: event.eventType,
      contenderName: event.contenderName,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function withActionEventTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Contender action event insert timed out.")), actionEventInsertTimeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
