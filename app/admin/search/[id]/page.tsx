import Link from "next/link";
import { notFound } from "next/navigation";
import { contenderNamesFromResult, getAdminSearchDetail, sourcesFromResult } from "@/lib/server/admin-dashboard";

export const dynamic = "force-dynamic";

type AdminSearchDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function AdminSearchDetailPage({ params }: AdminSearchDetailPageProps) {
  const { id } = await params;
  const { event, unavailableReason } = await getAdminSearchDetail(id);

  if (unavailableReason) {
    return (
      <main className="min-h-screen bg-[#FAFAF8] px-4 py-8 text-[#171717] sm:px-6 lg:px-10">
        <div className="mx-auto max-w-5xl">
          <BackLink />
          <div className="mt-8 rounded-lg border border-[#E7E3DB] bg-white p-5 text-sm text-[#62625C]">{unavailableReason}</div>
        </div>
      </main>
    );
  }

  if (!event) {
    notFound();
  }

  const result = event.cacheResult;
  const contenderNames = contenderNamesFromResult(result);
  const sources = sourcesFromResult(result);

  return (
    <main className="min-h-screen bg-[#FAFAF8] px-4 py-8 text-[#171717] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <BackLink />

        <header className="mt-8 border-b border-[#E7E3DB] pb-7">
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-[#9B9B92]">Search detail</p>
          <h1 className="mt-3 font-serif text-4xl tracking-[-0.035em] text-[#111114]">{event.original_query ?? event.normalized_query ?? "Untitled search"}</h1>
          <p className="mt-3 text-sm leading-6 text-[#77776F]">{formatDate(event.created_at)}</p>
        </header>

        <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Classification" value={event.consensus_mode?.replaceAll("_", " ") ?? "unknown"} />
          <Metric label="Cache" value={formatBoolean(event.cache_hit)} />
          <Metric label="Total response" value={formatMs(event.total_ms)} />
          <Metric label="Contenders" value={String(contenderNames.length)} />
        </section>

        <section className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Panel title="Query fields">
            <Field label="Original query" value={event.original_query} />
            <Field label="Normalized query" value={event.normalized_query} />
            <Field label="Canonical query" value={event.canonical_query} />
            <Field label="Evidence type" value={event.evidence_type} />
            <Field label="Cache version" value={formatNullableNumber(event.cache_version)} />
            <Field label="Search ID" value={event.search_id} />
          </Panel>

          <Panel title="Timing and calls">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Cache" value={formatMs(event.cache_ms)} />
              <Field label="Tavily" value={formatMs(event.tavily_ms)} />
              <Field label="OpenAI" value={formatMs(event.openai_ms)} />
              <Field label="Cache write" value={formatMs(event.cache_write_ms)} />
              <Field label="Tavily calls" value={formatNullableNumber(event.tavily_calls)} />
              <Field label="OpenAI calls" value={formatNullableNumber(event.openai_calls)} />
              <Field label="Places API calls" value={formatNullableNumber(event.places_api_calls)} />
              <Field label="Places cache hits" value={formatNullableNumber(event.places_cache_hits)} />
              <Field label="Places validations" value={formatNullableNumber(event.places_validation_attempts)} />
            </div>
          </Panel>
        </section>

        {event.error ? (
          <section className="mt-8 rounded-lg border border-[#E7D0C8] bg-[#FFF8F5] p-5">
            <h2 className="font-serif text-2xl tracking-[-0.03em] text-[#8B3A2B]">Error</h2>
            <p className="mt-3 text-sm leading-6 text-[#8B3A2B]">{event.error}</p>
          </section>
        ) : null}

        <section className="mt-8 grid gap-8 lg:grid-cols-2">
          <Panel title="Contenders">
            {contenderNames.length === 0 ? (
              <p className="text-sm text-[#77776F]">No cached contender names are available for this event.</p>
            ) : (
              <ul className="divide-y divide-[#ECE8E0]">
                {contenderNames.map((name) => (
                  <li key={name} className="py-3 text-sm text-[#3D3D38]">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Sources">
            {sources.length === 0 ? (
              <p className="text-sm text-[#77776F]">No cached sources are available for this event.</p>
            ) : (
              <ul className="divide-y divide-[#ECE8E0]">
                {sources.slice(0, 20).map((source) => (
                  <li key={`${source.url}-${source.title}`} className="py-3">
                    <a href={source.url} className="text-sm font-medium text-[#111114] hover:underline" target="_blank" rel="noreferrer">
                      {source.title}
                    </a>
                    <p className="mt-1 text-xs text-[#8B887F]">{source.domain}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>

        <section className="mt-8 rounded-lg border border-[#E7E3DB] bg-white p-5">
          <h2 className="font-serif text-2xl tracking-[-0.03em] text-[#111114]">Cached result payload</h2>
          <p className="mt-1 text-sm text-[#77776F]">
            Available only when the event has a search cache row. Safety bypasses and failed searches may not have a payload.
          </p>
          <pre className="mt-4 max-h-[34rem] overflow-auto rounded-md bg-[#111114] p-4 text-xs leading-5 text-[#F8F6F0]">
            {result ? JSON.stringify(compactPayload(result), null, 2) : "No cached result payload available."}
          </pre>
        </section>
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/admin" className="text-sm text-[#62625C] transition hover:text-[#111114]">
      ← Back to admin
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#E7E3DB] bg-white p-4 shadow-[0_10px_30px_rgba(17,17,20,0.035)]">
      <p className="text-xs uppercase tracking-[0.18em] text-[#9B9B92]">{label}</p>
      <p className="mt-3 text-sm font-medium text-[#111114]">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[#E7E3DB] bg-white p-5">
      <h2 className="font-serif text-2xl tracking-[-0.03em] text-[#111114]">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.16em] text-[#9B9B92]">{label}</p>
      <p className="mt-1 break-words text-sm text-[#3D3D38]">{value || "—"}</p>
    </div>
  );
}

function compactPayload(result: NonNullable<Awaited<ReturnType<typeof getAdminSearchDetail>>["event"]>["cacheResult"]) {
  if (!result) return null;

  return {
    id: result.id,
    query: result.query,
    normalizedQuery: result.normalizedQuery,
    canonicalQuery: result.canonicalQuery,
    mode: result.mode,
    headline: result.headline,
    explanation: result.explanation,
    intent: result.intent,
    results: result.results?.map((item) => ({
      name: item.name,
      rank: item.rank,
      summary: item.summary,
      reasons: item.reasons,
      verifiedAddress: item.verifiedAddress
    })),
    sources: result.sources?.map((source) => ({
      title: source.title,
      domain: source.domain,
      url: source.url
    }))
  };
}

function formatMs(value?: number | null) {
  if (typeof value !== "number") return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

function formatBoolean(value?: boolean | null) {
  if (typeof value !== "boolean") return "—";
  return value ? "Hit" : "Miss";
}

function formatNullableNumber(value?: number | null) {
  if (typeof value !== "number") return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
