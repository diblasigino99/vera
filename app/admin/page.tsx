import Link from "next/link";
import {
  categoryLabelForEvent,
  contenderNamesFromResult,
  getAdminDashboardData,
  type AdminEventWithCache
} from "@/lib/server/admin-dashboard";
import type { AdminFeedbackEvent } from "@/lib/server/feedback";

export const dynamic = "force-dynamic";

type AdminPageProps = {
  searchParams?: Promise<{
    filter?: string;
  }>;
};

const filters = [
  { key: "recent", label: "Recent" },
  { key: "no-consensus", label: "No consensus" },
  { key: "slow", label: "Slow > 15s" },
  { key: "errors", label: "Errors" },
  { key: "zero-contenders", label: "Zero contenders" }
];

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const params = await searchParams;
  const activeFilter = params?.filter ?? "recent";
  const data = await getAdminDashboardData();
  const visibleRows = rowsForFilter(activeFilter, data);

  return (
    <main className="min-h-screen bg-[#FAFAF8] px-4 py-6 text-[#171717] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-[#E7E3DB] pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-[#9B9B92]">Vera Admin</p>
            <h1 className="mt-3 font-serif text-4xl tracking-[-0.035em] text-[#111114] sm:text-5xl">Launch operations</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#62625C]">
              Read-only search health, quality, and cost signals from Supabase search events and cached result payloads.
            </p>
          </div>
          <Link href="/vera" className="text-sm text-[#62625C] transition hover:text-[#111114]">
            Open Vera
          </Link>
        </header>

        {data.unavailableReason ? (
          <section className="mt-8 rounded-lg border border-[#E7E3DB] bg-white p-5 text-sm text-[#62625C]">
            {data.unavailableReason}
          </section>
        ) : null}

        <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Total searches" value={formatNumber(data.overview.totalSearches)} />
          <MetricCard label="Today" value={formatNumber(data.overview.searchesToday)} />
          <MetricCard label="Last 7 days" value={formatNumber(data.overview.searchesLast7Days)} />
          <MetricCard label="Errors" value={formatNumber(data.overview.errorCount)} tone={data.overview.errorCount > 0 ? "warning" : "normal"} />
          <MetricCard label="Cache-hit rate" value={formatPercent(data.overview.cacheHitRate)} />
          <MetricCard label="No-consensus rate" value={formatPercent(data.overview.noConsensusRate)} />
          <MetricCard label="Avg response" value={formatMs(data.overview.averageResponseMs)} />
          <MetricCard label="Feedback" value={formatNumber(data.feedback.total)} />
        </section>

        <section className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <SectionHeading title="Category breakdown" subtitle="Grouped from evidence type and safety bypass metadata." />
            <div className="mt-4 divide-y divide-[#ECE8E0] rounded-lg border border-[#E7E3DB] bg-white">
              {data.categoryBreakdown.map((item) => (
                <div key={item.label} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm capitalize text-[#3D3D38]">{item.label}</span>
                  <span className="font-mono text-sm text-[#77776F]">{formatNumber(item.count)}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <SectionHeading title="Problem searches" subtitle="Fast filters for launch-trust review." />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ProblemLink href="/admin?filter=no-consensus" label="No reliable consensus" count={data.problemSearches.noConsensus.length} />
              <ProblemLink href="/admin?filter=slow" label="Slow over 15 seconds" count={data.problemSearches.slow.length} />
              <ProblemLink href="/admin?filter=errors" label="Errors" count={data.problemSearches.errors.length} />
              <ProblemLink href="/admin?filter=zero-contenders" label="Zero contenders" count={data.problemSearches.zeroContenders.length} />
              <div className="rounded-lg border border-[#E7E3DB] bg-white p-4 sm:col-span-2">
                <span className="block text-sm text-[#3D3D38]">Reported results</span>
                <span className="mt-2 block font-mono text-lg text-[#111114]">
                  {formatNumber(data.feedback.recent.filter((item) => item.feedback_type === "report_issue").length)}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-10">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <SectionHeading title="Searches" subtitle="Newest first. Click any row to inspect result payload, sources, and call timings." />
            <nav className="flex flex-wrap gap-2">
              {filters.map((filter) => (
                <Link
                  key={filter.key}
                  href={filter.key === "recent" ? "/admin" : `/admin?filter=${filter.key}`}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    activeFilter === filter.key
                      ? "border-[#111114] bg-[#111114] text-white"
                      : "border-[#E1DDD5] bg-white text-[#62625C] hover:border-[#BEB7AA] hover:text-[#111114]"
                  }`}
                >
                  {filter.label}
                </Link>
              ))}
            </nav>
          </div>

          <SearchTable rows={visibleRows} />
        </section>

        <section className="mt-10">
          <SectionHeading title="Recent feedback" subtitle="Newest feedback submissions from public result pages." />
          <FeedbackTable rows={data.feedback.recent} />
        </section>
      </div>
    </main>
  );
}

function rowsForFilter(activeFilter: string, data: Awaited<ReturnType<typeof getAdminDashboardData>>) {
  if (activeFilter === "no-consensus") return data.problemSearches.noConsensus;
  if (activeFilter === "slow") return data.problemSearches.slow;
  if (activeFilter === "errors") return data.problemSearches.errors;
  if (activeFilter === "zero-contenders") return data.problemSearches.zeroContenders;
  return data.recentSearches;
}

function MetricCard({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "warning" }) {
  return (
    <div className="rounded-lg border border-[#E7E3DB] bg-white p-4 shadow-[0_10px_30px_rgba(17,17,20,0.035)]">
      <p className="text-xs uppercase tracking-[0.18em] text-[#9B9B92]">{label}</p>
      <p className={`mt-3 font-serif text-3xl tracking-[-0.035em] ${tone === "warning" ? "text-[#9B3D2E]" : "text-[#111114]"}`}>{value}</p>
    </div>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="font-serif text-2xl tracking-[-0.03em] text-[#111114]">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-[#77776F]">{subtitle}</p>
    </div>
  );
}

function ProblemLink({ href, label, count }: { href: string; label: string; count: number }) {
  return (
    <a href={href} className="rounded-lg border border-[#E7E3DB] bg-white p-4 transition hover:border-[#CFC7BA]">
      <span className="block text-sm text-[#3D3D38]">{label}</span>
      <span className="mt-2 block font-mono text-lg text-[#111114]">{formatNumber(count)}</span>
    </a>
  );
}

function SearchTable({ rows }: { rows: AdminEventWithCache[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-[#E7E3DB] bg-white">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[#ECE8E0] text-left text-sm">
          <thead className="bg-[#F5F3EE] text-xs uppercase tracking-[0.16em] text-[#8B887F]">
            <tr>
              <th className="px-4 py-3 font-medium">Query</th>
              <th className="px-4 py-3 font-medium">Evidence</th>
              <th className="px-4 py-3 font-medium">Classification</th>
              <th className="px-4 py-3 font-medium">Cache</th>
              <th className="px-4 py-3 font-medium">Total</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#ECE8E0]">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-[#77776F]" colSpan={6}>
                  No searches found for this view.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="transition hover:bg-[#FAF9F6]">
                  <td className="max-w-[28rem] px-4 py-3">
                    <Link href={`/admin/search/${row.id}`} className="font-medium text-[#111114] hover:underline">
                      {row.original_query ?? row.normalized_query ?? "Untitled search"}
                    </Link>
                    <p className="mt-1 truncate text-xs text-[#8B887F]">{contenderNamesFromResult(row.cacheResult).join(", ") || "No cached contenders available"}</p>
                  </td>
                  <td className="px-4 py-3 text-[#62625C]">{categoryLabelForEvent(row)}</td>
                  <td className="px-4 py-3">
                    <StatusLabel value={row.consensus_mode ?? "unknown"} />
                  </td>
                  <td className="px-4 py-3 text-[#62625C]">{formatBoolean(row.cache_hit)}</td>
                  <td className="px-4 py-3 font-mono text-[#3D3D38]">{formatMs(row.total_ms)}</td>
                  <td className="px-4 py-3 text-[#62625C]">{formatDate(row.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeedbackTable({ rows }: { rows: AdminFeedbackEvent[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-[#E7E3DB] bg-white">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[#ECE8E0] text-left text-sm">
          <thead className="bg-[#F5F3EE] text-xs uppercase tracking-[0.16em] text-[#8B887F]">
            <tr>
              <th className="px-4 py-3 font-medium">Feedback</th>
              <th className="px-4 py-3 font-medium">Query</th>
              <th className="px-4 py-3 font-medium">Evidence</th>
              <th className="px-4 py-3 font-medium">Classification</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#ECE8E0]">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-[#77776F]" colSpan={5}>
                  No feedback submitted yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="transition hover:bg-[#FAF9F6]">
                  <td className="px-4 py-3">
                    <Link href={`/admin/feedback/${row.id}`} className="font-medium text-[#111114] hover:underline">
                      {feedbackTypeLabel(row.feedback_type)}
                    </Link>
                    {row.feedback_text ? <p className="mt-1 max-w-xs truncate text-xs text-[#8B887F]">{row.feedback_text}</p> : null}
                  </td>
                  <td className="max-w-[24rem] px-4 py-3 text-[#3D3D38]">{row.search_query || "—"}</td>
                  <td className="px-4 py-3 text-[#62625C]">{row.evidence_type || "—"}</td>
                  <td className="px-4 py-3 text-[#62625C]">{row.consensus_classification?.replaceAll("_", " ") || "—"}</td>
                  <td className="px-4 py-3 text-[#62625C]">{formatDate(row.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusLabel({ value }: { value: string }) {
  const isProblem = value === "no_reliable_consensus" || value === "unknown";
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs ${isProblem ? "bg-[#F7EFEA] text-[#8B3A2B]" : "bg-[#EFF4EA] text-[#3F6B37]"}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
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

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function feedbackTypeLabel(value: AdminFeedbackEvent["feedback_type"]) {
  if (value === "report_issue") return "Report issue";
  if (value === "yes") return "Useful";
  return "Not useful";
}
