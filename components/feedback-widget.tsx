"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type FeedbackType = "yes" | "no" | "report_issue";
type FeedbackStatus = "idle" | "writing" | "submitting" | "submitted" | "failed";

type FeedbackWidgetProps = {
  searchQuery: string;
  resultSlug?: string;
  evidenceType?: string;
  consensusClassification?: string;
  compact?: boolean;
};

export function FeedbackWidget({
  searchQuery,
  resultSlug,
  evidenceType,
  consensusClassification,
  compact = false
}: FeedbackWidgetProps) {
  const [selectedType, setSelectedType] = useState<FeedbackType | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [status, setStatus] = useState<FeedbackStatus>("idle");

  const showTextBox = selectedType === "no" || selectedType === "report_issue";

  async function submitFeedback(feedbackType: FeedbackType, text = feedbackText) {
    setSelectedType(feedbackType);

    if ((feedbackType === "no" || feedbackType === "report_issue") && status !== "submitting" && selectedType !== feedbackType) {
      setStatus("writing");
      return;
    }

    setStatus("submitting");

    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        searchQuery,
        resultSlug,
        feedbackType,
        feedbackText: text,
        evidenceType,
        consensusClassification
      })
    });

    if (!response.ok) {
      setStatus("failed");
      return;
    }

    setStatus("submitted");
    setFeedbackText("");
  }

  if (status === "submitted") {
    return (
      <section className={cn("border-t border-[#ECECF0] pt-8", compact ? "mt-8" : "mt-12")}>
        <p className="text-sm font-medium text-[#111114]">Thanks for the signal.</p>
        <p className="mt-2 text-sm leading-6 text-[#73737C]">We’ll use it to review Vera’s launch results.</p>
      </section>
    );
  }

  return (
    <section className={cn("border-t border-[#ECECF0] pt-8", compact ? "mt-8" : "mt-12")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Feedback</p>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.01em] text-[#111114]">Was this useful?</h2>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <FeedbackButton active={selectedType === "yes"} onClick={() => submitFeedback("yes")}>
            Yes
          </FeedbackButton>
          <FeedbackButton active={selectedType === "no"} onClick={() => submitFeedback("no")}>
            No
          </FeedbackButton>
          <FeedbackButton active={selectedType === "report_issue"} onClick={() => submitFeedback("report_issue")}>
            Report an issue
          </FeedbackButton>
        </div>
      </div>

      {showTextBox ? (
        <div className="mt-5">
          <label className="text-sm font-medium text-[#4B4B52]" htmlFor="vera-feedback-text">
            Tell us what went wrong.
          </label>
          <textarea
            id="vera-feedback-text"
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
            rows={4}
            className="mt-2 w-full resize-y rounded-2xl border border-[#E4E4EA] bg-white px-4 py-3 text-sm leading-6 text-[#111114] outline-none transition focus:border-[#BFC1C8] focus:shadow-[0_10px_30px_rgba(17,17,20,0.06)]"
            placeholder="Optional"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => selectedType && submitFeedback(selectedType)}
              disabled={status === "submitting"}
              className="rounded-full bg-[#111114] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#2C2C30] disabled:cursor-default disabled:opacity-60"
            >
              {status === "submitting" ? "Sending..." : "Send feedback"}
            </button>
            {status === "failed" ? <p className="text-sm text-[#9B3D2E]">Feedback could not be submitted. Please try again.</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FeedbackButton({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-4 py-2 text-sm font-medium transition",
        active
          ? "border-[#111114] bg-[#111114] text-white"
          : "border-[#E4E4EA] bg-white text-[#62626A] hover:border-[#C9CAD1] hover:text-[#111114]"
      )}
    >
      {children}
    </button>
  );
}
