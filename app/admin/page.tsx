import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import {
  type AdminDashboardFilters,
  categoryLabelForEvent,
  getAdminDashboardData,
  type AdminEventWithCache
} from "@/lib/server/admin-dashboard";
import type { AdminFeedbackEvent } from "@/lib/server/feedback";

export const dynamic = "force-dynamic";

type AdminPageProps = {
  searchParams?: Promise<AdminDashboardFilters & {
    filter?: string;
  }>;
};

const filters = [
  { key: "recent", label: "Recent" },
  { key: "no-consensus", label: "No consensus" },
  { key: "slow", label: "Slow > 15s" },
  { key: "errors", label: "Errors" }
];

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const params = await searchParams;
  const activeFilter = params?.filter ?? "recent";
  const data = await getAdminDashboardData(params ?? {});
  const visibleRows = rowsForFilter(activeFilter, data);
  const baseParams = paramsForLinks(data.filters);

  return (
    <main className="min-h-screen bg-[#FAFAF8] px-4 py-6 text-[#171717] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-[#E7E3DB] pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-[#9B9B92]">Vera Admin</p>
            <h1 className="mt-3 font-serif text-4xl tracking-[-0.035em] text-[#111114] sm:text-5xl">Launch operations</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#62625C]">
              Read-only learning console for what people search, which decisions they bring to Vera, and where the product needs attention.
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

        <section className="mt-8 rounded-xl border border-[#E7E3DB] bg-white p-4 shadow-[0_10px_30px_rgba(17,17,20,0.025)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#9B9B92]">Analysis window</p>
              <p className="mt-2 text-sm text-[#62625C]">{data.rangeLabel} · {formatNumber(data.sampleSize)} searches in view</p>
            </div>
            <DateRangeLinks active={data.filters.dateRange} params={baseParams} />
          </div>
          <form className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-[1.3fr_0.9fr_0.9fr_0.8fr_0.8fr]">
            <input type="hidden" name="dateRange" value={data.filters.dateRange} />
            <input type="hidden" name="sort" value={data.filters.sort} />
            <FilterField label="Search text">
              <input
                name="searchText"
                defaultValue={data.filters.searchText}
                placeholder="Query contains..."
                className="h-10 w-full rounded-md border border-[#DDD8CF] bg-white px-3 text-sm outline-none transition focus:border-[#A9A194]"
              />
            </FilterField>
            <FilterField label="Category">
              <select name="category" defaultValue={data.filters.category} className="h-10 w-full rounded-md border border-[#DDD8CF] bg-white px-3 text-sm outline-none">
                <option value="all">All categories</option>
                <option value="local">Local</option>
                <option value="destination">Destination</option>
                <option value="product">Products</option>
                <option value="software/tools">Software</option>
                <option value="provider/brand">Provider/Brand</option>
                <option value="negative/safety">Safety/Negative</option>
                <option value="unclear/other">Unknown</option>
              </select>
            </FilterField>
            <FilterField label="Consensus">
              <select name="consensus" defaultValue={data.filters.consensus} className="h-10 w-full rounded-md border border-[#DDD8CF] bg-white px-3 text-sm outline-none">
                <option value="all">All consensus</option>
                <option value="strong">Strong</option>
                <option value="moderate">Moderate</option>
                <option value="split">Split</option>
                <option value="no_reliable_consensus">No Reliable Consensus</option>
              </select>
            </FilterField>
            <FilterField label="Cache">
              <select name="cache" defaultValue={data.filters.cache} className="h-10 w-full rounded-md border border-[#DDD8CF] bg-white px-3 text-sm outline-none">
                <option value="all">All</option>
                <option value="hit">Cached</option>
                <option value="miss">Uncached</option>
              </select>
            </FilterField>
            <div className="flex items-end gap-2">
              <button className="h-10 rounded-md bg-[#111114] px-4 text-sm text-white transition hover:bg-[#2B2B2D]">Apply</button>
              <Link href="/admin" className="flex h-10 items-center rounded-md border border-[#DDD8CF] px-4 text-sm text-[#62625C] transition hover:text-[#111114]">
                Reset
              </Link>
            </div>
          </form>
          {data.filters.dateRange === "custom" ? (
            <form className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="dateRange" value="custom" />
              <input type="hidden" name="searchText" value={data.filters.searchText} />
              <input type="hidden" name="category" value={data.filters.category} />
              <input type="hidden" name="consensus" value={data.filters.consensus} />
              <input type="hidden" name="cache" value={data.filters.cache} />
              <FilterField label="Start date">
                <input type="date" name="startDate" defaultValue={data.filters.startDate} className="h-10 rounded-md border border-[#DDD8CF] bg-white px-3 text-sm outline-none" />
              </FilterField>
              <FilterField label="End date">
                <input type="date" name="endDate" defaultValue={data.filters.endDate} className="h-10 rounded-md border border-[#DDD8CF] bg-white px-3 text-sm outline-none" />
              </FilterField>
              <button className="h-10 rounded-md bg-[#111114] px-4 text-sm text-white transition hover:bg-[#2B2B2D]">Set range</button>
            </form>
          ) : null}
        </section>

        <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Total searches" value={formatNumber(data.overview.totalSearches)} />
          <MetricCard label="Unique sessions" value="Unavailable" />
          <MetricCard label="Avg search time" value={formatMs(data.overview.averageResponseMs)} />
          <MetricCard label="No-consensus rate" value={formatPercent(data.overview.noConsensusRate)} />
          <MetricCard label="Cached searches" value={formatPercent(data.overview.cacheHitRate)} />
          <MetricCard label="Avg confidence" value={formatScore(data.overview.averageConfidenceScore)} />
          <MetricCard label="Errors" value={formatNumber(data.overview.errorCount)} tone={data.overview.errorCount > 0 ? "warning" : "normal"} />
          <MetricCard label="Feedback" value={formatNumber(data.feedback.total)} />
        </section>

        <section className="mt-10 grid gap-8 lg:grid-cols-3">
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
            <SectionHeading title="Decision buckets" subtitle="Simple heuristics for what people are trying to decide." />
            <div className="mt-4 divide-y divide-[#ECE8E0] rounded-lg border border-[#E7E3DB] bg-white">
              {data.decisionBreakdown.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm text-[#3D3D38]">{item.label}</span>
                  <span className="font-mono text-sm text-[#77776F]">{formatNumber(item.count)}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <SectionHeading title="Problem searches" subtitle="Fast filters for launch-trust review." />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ProblemLink href={adminHref(baseParams, { filter: "no-consensus" })} label="No reliable consensus" count={data.problemSearches.noConsensus.length} />
              <ProblemLink href={adminHref(baseParams, { filter: "slow" })} label="Slow over 15 seconds" count={data.problemSearches.slow.length} />
              <ProblemLink href={adminHref(baseParams, { filter: "errors" })} label="Errors" count={data.problemSearches.errors.length} />
              <div className="rounded-lg border border-[#E7E3DB] bg-white p-4 sm:col-span-2">
                <span className="block text-sm text-[#3D3D38]">Negative feedback</span>
                <span className="mt-2 block font-mono text-lg text-[#111114]">
                  {formatNumber(data.feedback.recent.filter((item) => item.helpful === false || item.feedback_type === "report_issue").length)}
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
                  href={adminHref(baseParams, filter.key === "recent" ? { filter: "" } : { filter: filter.key })}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    activeFilter === filter.key
                      ? "border-[#111114] bg-[#111114] text-white"
                      : "border-[#E1DDD5] bg-white text-[#62625C] hover:border-[#BEB7AA] hover:text-[#111114]"
                  }`}
                >
                  {filter.label}
                </Link>
              ))}
              <Link
                href={adminHref(baseParams, { sort: "slowest" })}
                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                  data.filters.sort === "slowest"
                    ? "border-[#111114] bg-[#111114] text-white"
                    : "border-[#E1DDD5] bg-white text-[#62625C] hover:border-[#BEB7AA] hover:text-[#111114]"
                }`}
              >
                Slowest searches
              </Link>
              <Link
                href={adminHref(baseParams, { sort: "fastest" })}
                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                  data.filters.sort === "fastest"
                    ? "border-[#111114] bg-[#111114] text-white"
                    : "border-[#E1DDD5] bg-white text-[#62625C] hover:border-[#BEB7AA] hover:text-[#111114]"
                }`}
              >
                Fastest searches
              </Link>
            </nav>
          </div>

          <SearchTable rows={visibleRows} />
        </section>

        <section className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div>
            <SectionHeading title="Category health" subtitle="Where Vera is strongest, slowest, or too often inconclusive." />
            <CategoryAnalysisTable rows={data.categoryAnalysis} />
          </div>
          <div>
            <SectionHeading title="Top searches" subtitle="Repeated questions are the clearest signal of user intent." />
            <TopSearchesTable rows={data.topSearches} />
          </div>
        </section>

        <section className="mt-10 grid gap-8 lg:grid-cols-2">
          <div>
            <SectionHeading title="Slowest searches" subtitle="Latency diagnostics for the selected filters." />
            <CompactSearchList rows={data.latencySearches.slowest} />
          </div>
          <div>
            <SectionHeading title="Fastest searches" subtitle="Useful baseline for what the pipeline can feel like." />
            <CompactSearchList rows={data.latencySearches.fastest} />
          </div>
        </section>

        <section className="mt-10">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <SectionHeading title="Recent feedback" subtitle="Newest feedback submissions from public result pages." />
            <FeedbackFilters filters={data.filters} params={baseParams} />
          </div>
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
  return data.recentSearches;
}

function DateRangeLinks({ active, params }: { active: string; params: URLSearchParams }) {
  const ranges = [
    { key: "today", label: "Today" },
    { key: "7d", label: "Last 7 Days" },
    { key: "30d", label: "Last 30 Days" },
    { key: "all", label: "All Time" },
    { key: "custom", label: "Custom Date Range" }
  ];

  return (
    <nav className="flex flex-wrap gap-2">
      {ranges.map((range) => (
        <Link
          key={range.key}
          href={adminHref(params, { dateRange: range.key })}
          className={`rounded-full border px-3 py-1.5 text-xs transition ${
            active === range.key
              ? "border-[#111114] bg-[#111114] text-white"
              : "border-[#E1DDD5] bg-white text-[#62625C] hover:border-[#BEB7AA] hover:text-[#111114]"
          }`}
        >
          {range.label}
        </Link>
      ))}
    </nav>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.16em] text-[#9B9B92]">{label}</span>
      {children}
    </label>
  );
}

function MetricCard({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "warning" }) {
  return (
    <div className="rounded-lg border border-[#E7E3DB] bg-white p-4 shadow-[0_10px_30px_rgba(17,17,20,0.035)]">
      <p className="text-xs uppercase tracking-[0.18em] text-[#9B9B92]">{label}</p>
      <p className={`mt-3 font-serif text-3xl tracking-[-0.035em] ${tone === "warning" ? "text-[#9B3D2E]" : "text-[#111114]"}`}>{value}</p>
    </div>
  );
}

function CategoryAnalysisTable({ rows }: { rows: Awaited<ReturnType<typeof getAdminDashboardData>>["categoryAnalysis"] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-[#E7E3DB] bg-white">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[#ECE8E0] text-left text-sm">
          <thead className="bg-[#F5F3EE] text-xs uppercase tracking-[0.16em] text-[#8B887F]">
            <tr>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Searches</th>
              <th className="px-4 py-3 font-medium">Consensus</th>
              <th className="px-4 py-3 font-medium">No consensus</th>
              <th className="px-4 py-3 font-medium">Avg latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#ECE8E0]">
            {rows.map((row) => (
              <tr key={row.label}>
                <td className="px-4 py-3 capitalize text-[#3D3D38]">{row.label}</td>
                <td className="px-4 py-3 font-mono text-[#62625C]">{formatNumber(row.count)}</td>
                <td className="px-4 py-3 text-xs text-[#62625C]">
                  Strong {formatNumber(row.strong)} · Moderate {formatNumber(row.moderate)} · Split {formatNumber(row.split)}
                </td>
                <td className="px-4 py-3 text-[#62625C]">{formatPercent(row.noConsensusRate)}</td>
                <td className="px-4 py-3 font-mono text-[#3D3D38]">{formatMs(row.averageResponseMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TopSearchesTable({ rows }: { rows: Awaited<ReturnType<typeof getAdminDashboardData>>["topSearches"] }) {
  return (
    <div className="mt-4 divide-y divide-[#ECE8E0] rounded-lg border border-[#E7E3DB] bg-white">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[#77776F]">No repeated searches in this view.</p>
      ) : (
        rows.map((row) => (
          <div key={row.query} className="flex items-start justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-[#111114]">{row.query}</p>
              <p className="mt-1 text-xs capitalize text-[#8B887F]">{row.category} · last seen {formatDate(row.lastSearchedAt)}</p>
            </div>
            <span className="font-mono text-sm text-[#62625C]">{formatNumber(row.count)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function CompactSearchList({ rows }: { rows: AdminEventWithCache[] }) {
  return (
    <div className="mt-4 divide-y divide-[#ECE8E0] rounded-lg border border-[#E7E3DB] bg-white">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[#77776F]">No searches found.</p>
      ) : (
        rows.map((row) => (
          <Link key={row.id} href={`/admin/search/${row.id}`} className="block px-4 py-3 transition hover:bg-[#FAF9F6]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-[#111114]">{row.original_query ?? row.normalized_query ?? "Untitled search"}</p>
                <p className="mt-1 text-xs capitalize text-[#8B887F]">{categoryLabelForEvent(row)} · {row.consensus_mode?.replaceAll("_", " ") ?? "unknown"}</p>
              </div>
              <span className="font-mono text-sm text-[#3D3D38]">{formatMs(row.total_ms)}</span>
            </div>
          </Link>
        ))
      )}
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
                    <p className="mt-1 truncate text-xs text-[#8B887F]">Open search detail for contenders and sources</p>
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
              <th className="px-4 py-3 font-medium">Reason</th>
              <th className="px-4 py-3 font-medium">Query</th>
              <th className="px-4 py-3 font-medium">Classification</th>
              <th className="px-4 py-3 font-medium">Contenders</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#ECE8E0]">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-[#77776F]" colSpan={6}>
                  No feedback submitted yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className={`transition hover:bg-[#FAF9F6] ${row.helpful === false ? "bg-[#FFF9F6]" : ""}`}>
                  <td className="px-4 py-3">
                    <Link href={`/admin/feedback/${row.id}`} className={`font-medium hover:underline ${row.helpful === false ? "text-[#8B3A2B]" : "text-[#111114]"}`}>
                      {feedbackTypeLabel(row.feedback_type)}
                    </Link>
                    {row.feedback_text ? <p className="mt-1 max-w-xs truncate text-xs text-[#8B887F]">{row.feedback_text}</p> : null}
                  </td>
                  <td className="px-4 py-3 text-[#62625C]">{feedbackReasonLabel(row.feedback_reason)}</td>
                  <td className="max-w-[24rem] px-4 py-3 text-[#3D3D38]">{row.search_query || "—"}</td>
                  <td className="px-4 py-3 text-[#62625C]">{row.consensus_classification?.replaceAll("_", " ") || "—"}</td>
                  <td className="max-w-[20rem] px-4 py-3 text-[#62625C]">{formatContenders(row.displayed_contenders)}</td>
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

function FeedbackFilters({
  filters,
  params
}: {
  filters: Awaited<ReturnType<typeof getAdminDashboardData>>["filters"];
  params: URLSearchParams;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {[
        { value: "all", label: "All" },
        { value: "negative", label: "Not helpful" },
        { value: "positive", label: "Helpful" }
      ].map((item) => (
        <Link
          href={adminHref(params, { feedbackSentiment: item.value })}
          key={item.value}
          className={`rounded-full border px-3 py-1.5 text-xs transition ${
            filters.feedbackSentiment === item.value
              ? "border-[#111114] bg-[#111114] text-white"
              : "border-[#E1DDD5] bg-white text-[#62625C] hover:border-[#BEB7AA] hover:text-[#111114]"
          }`}
        >
          {item.label}
        </Link>
      ))}
      <form className="flex gap-2">
        {Array.from(params.entries())
          .filter(([key]) => key !== "feedbackReason")
          .map(([key, value]) => (
            <input key={`${key}-${value}`} name={key} type="hidden" value={value} />
          ))}
        <select
          aria-label="Feedback reason"
          className="h-8 rounded-full border border-[#E1DDD5] bg-white px-3 text-xs text-[#62625C] outline-none"
          defaultValue={filters.feedbackReason}
          name="feedbackReason"
        >
          <option value="all">All reasons</option>
          <option value="wrong_recommendations">Wrong recommendations</option>
          <option value="missing_obvious">Missing something obvious</option>
          <option value="unconvincing_sources">Sources weren&apos;t convincing</option>
          <option value="misunderstood_search">Didn&apos;t understand my search</option>
          <option value="other">Other</option>
        </select>
        <button className="h-8 rounded-full border border-[#E1DDD5] bg-white px-3 text-xs text-[#62625C] transition hover:border-[#BEB7AA] hover:text-[#111114]">
          Filter
        </button>
      </form>
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

function formatScore(value?: number | null) {
  if (typeof value !== "number") return "—";
  return value.toFixed(2);
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
  if (value === "yes") return "Helpful";
  return "Not helpful";
}

function feedbackReasonLabel(value?: AdminFeedbackEvent["feedback_reason"]) {
  if (value === "wrong_recommendations") return "Wrong recommendations";
  if (value === "missing_obvious") return "Missing something obvious";
  if (value === "unconvincing_sources") return "Sources weren't convincing";
  if (value === "misunderstood_search") return "Didn't understand search";
  if (value === "other") return "Other";
  return "—";
}

function formatContenders(value?: string[] | null) {
  if (!value?.length) return "—";
  return value.slice(0, 4).join(", ");
}

function paramsForLinks(filters: Awaited<ReturnType<typeof getAdminDashboardData>>["filters"]) {
  const params = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (shouldOmitAdminParam(key, value)) {
      return;
    }

    params.set(key, value);
  });

  return params;
}

function adminHref(baseParams: URLSearchParams, updates: Record<string, string>) {
  const params = new URLSearchParams(baseParams);

  Object.entries(updates).forEach(([key, value]) => {
    if (shouldOmitAdminParam(key, value)) {
      params.delete(key);
      return;
    }

    params.set(key, value);
  });

  const query = params.toString();
  return (query ? `/admin?${query}` : "/admin") as Route;
}

function shouldOmitAdminParam(key: string, value: string) {
  if (!value) return true;
  if (key === "dateRange") return value === "7d";
  return value === "all" || value === "newest";
}
