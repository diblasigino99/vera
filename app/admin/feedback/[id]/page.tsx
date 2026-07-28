import Link from "next/link";
import { notFound } from "next/navigation";
import { getFeedbackEvent } from "@/lib/server/feedback";

export const dynamic = "force-dynamic";

type AdminFeedbackDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function AdminFeedbackDetailPage({ params }: AdminFeedbackDetailPageProps) {
  const { id } = await params;
  const feedback = await getFeedbackEvent(id);

  if (!feedback) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-[#FAFAF8] px-4 py-8 text-[#171717] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <Link href="/admin" className="text-sm text-[#62625C] transition hover:text-[#111114]">
          ← Back to admin
        </Link>

        <header className="mt-8 border-b border-[#E7E3DB] pb-7">
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-[#9B9B92]">Feedback detail</p>
          <h1 className="mt-3 font-serif text-4xl tracking-[-0.035em] text-[#111114]">{feedbackTypeLabel(feedback.feedback_type)}</h1>
          <p className="mt-3 text-sm leading-6 text-[#77776F]">{formatDate(feedback.created_at)}</p>
        </header>

        <section className="mt-8 rounded-lg border border-[#E7E3DB] bg-white p-5">
          <h2 className="font-serif text-2xl tracking-[-0.03em] text-[#111114]">Submission</h2>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="Search query" value={feedback.search_query} />
            <Field label="Search id" value={feedback.search_id} />
            <Field label="Result slug" value={feedback.result_slug} />
            <Field label="Anonymous session" value={feedback.actor_id} />
            <Field label="Feedback type" value={feedbackTypeLabel(feedback.feedback_type)} />
            <Field label="Helpful" value={formatHelpful(feedback.helpful)} />
            <Field label="Reason" value={feedbackReasonLabel(feedback.feedback_reason)} />
            <Field label="Evidence type" value={feedback.evidence_type} />
            <Field label="Classification" value={feedback.consensus_classification?.replaceAll("_", " ")} />
            <Field label="Cache version" value={typeof feedback.cache_version === "number" ? String(feedback.cache_version) : null} />
            <Field label="Engine version" value={feedback.engine_version} />
            <Field label="Timestamp" value={formatDate(feedback.created_at)} />
          </div>
          <div className="mt-7 border-t border-[#ECE8E0] pt-5">
            <p className="text-xs uppercase tracking-[0.16em] text-[#9B9B92]">Displayed contenders</p>
            <p className="mt-2 text-sm leading-7 text-[#3D3D38]">{formatContenders(feedback.displayed_contenders)}</p>
          </div>
          <div className="mt-7 border-t border-[#ECE8E0] pt-5">
            <p className="text-xs uppercase tracking-[0.16em] text-[#9B9B92]">User note</p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[#3D3D38]">{feedback.feedback_text || "No note provided."}</p>
          </div>
        </section>
      </div>
    </main>
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

function feedbackTypeLabel(value: string) {
  if (value === "report_issue") return "Report issue";
  if (value === "yes") return "Helpful";
  return "Not helpful";
}

function feedbackReasonLabel(value?: string | null) {
  if (value === "wrong_recommendations") return "Wrong recommendations";
  if (value === "missing_obvious") return "Missing something obvious";
  if (value === "unconvincing_sources") return "Sources weren't convincing";
  if (value === "misunderstood_search") return "Didn't understand search";
  if (value === "other") return "Other";
  return "—";
}

function formatHelpful(value?: boolean | null) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "—";
}

function formatContenders(value?: string[] | null) {
  if (!value?.length) return "—";
  return value.join(", ");
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
