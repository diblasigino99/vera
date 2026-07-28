"use client";

import { useState } from "react";
import { getAnonymousId } from "@/lib/client/anonymous-id";
import { cn } from "@/lib/utils";

type FeedbackType = "yes" | "no" | "report_issue";
type FeedbackReason = "wrong_recommendations" | "missing_obvious" | "unconvincing_sources" | "misunderstood_search" | "other";
type FeedbackStatus = "idle" | "writing" | "submitting" | "submitted" | "failed";

type FeedbackWidgetProps = {
  searchId?: string;
  searchQuery: string;
  resultSlug?: string;
  evidenceType?: string;
  consensusClassification?: string;
  displayedContenders?: string[];
  cacheVersion?: number;
  compact?: boolean;
};

const negativeReasons: Array<{ value: FeedbackReason; label: string }> = [
  { value: "wrong_recommendations", label: "Wrong recommendations" },
  { value: "missing_obvious", label: "Missing something obvious" },
  { value: "unconvincing_sources", label: "Sources weren't convincing" },
  { value: "misunderstood_search", label: "Didn't understand my search" },
  { value: "other", label: "Other" }
];

export function FeedbackWidget({
  searchId,
  searchQuery,
  resultSlug,
  evidenceType,
  consensusClassification,
  displayedContenders = [],
  cacheVersion,
  compact = false
}: FeedbackWidgetProps) {
  const [selectedType, setSelectedType] = useState<FeedbackType | null>(null);
  const [feedbackReason, setFeedbackReason] = useState<FeedbackReason | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [status, setStatus] = useState<FeedbackStatus>("idle");

  const showNegativeStep = selectedType === "no";

  async function submitFeedback(feedbackType: FeedbackType, options: { reason?: FeedbackReason | null; text?: string } = {}) {
    if (status === "submitting") {
      return;
    }

    setSelectedType(feedbackType);

    if (feedbackType === "no" && !options.reason) {
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
        searchId,
        actorId: getAnonymousId(),
        searchQuery,
        resultSlug,
        feedbackType,
        helpful: feedbackType === "yes",
        feedbackReason: options.reason ?? null,
        feedbackText: options.text ?? feedbackText,
        evidenceType,
        consensusClassification,
        displayedContenders,
        cacheVersion,
        engineVersion: typeof cacheVersion === "number" ? `cache_v${cacheVersion}` : undefined
      })
    });

    if (!response.ok) {
      setStatus("failed");
      return;
    }

    setStatus("submitted");
    setFeedbackText("");
  }

  function selectNegativeReason(reason: FeedbackReason) {
    setFeedbackReason(reason);
    setStatus("writing");
  }

  if (status === "submitted") {
    return (
      <section className={cn("border-t border-[#ECECF0] pt-7", compact ? "mt-8" : "mt-12")}>
        <p className="text-sm font-medium text-[#111114]">Thanks for the feedback.</p>
      </section>
    );
  }

  return (
    <section className={cn("border-t border-[#ECECF0] pt-7", compact ? "mt-8" : "mt-12")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium text-[#111114]">Was this result helpful?</p>
        <div className="flex flex-wrap gap-2.5">
          <FeedbackButton active={selectedType === "yes"} disabled={status === "submitting"} onClick={() => submitFeedback("yes")}>
            Yes
          </FeedbackButton>
          <FeedbackButton active={selectedType === "no"} disabled={status === "submitting"} onClick={() => {
            setSelectedType("no");
            setStatus("writing");
          }}>
            Not really
          </FeedbackButton>
        </div>
      </div>

      {showNegativeStep ? (
        <div className="mt-5 max-w-2xl">
          <p className="text-sm font-medium text-[#111114]">What was off?</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {negativeReasons.map((reason) => (
              <FeedbackButton
                active={feedbackReason === reason.value}
                disabled={status === "submitting"}
                key={reason.value}
                onClick={() => selectNegativeReason(reason.value)}
              >
                {reason.label}
              </FeedbackButton>
            ))}
          </div>
          <label className="mt-5 block text-sm font-medium text-[#4B4B52]" htmlFor="vera-feedback-text">
            Tell us more (optional)
          </label>
          <textarea
            id="vera-feedback-text"
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
            rows={4}
            className="mt-2 w-full resize-y rounded-lg border border-[#E4E4EA] bg-white px-4 py-3 text-sm leading-6 text-[#111114] outline-none transition focus:border-[#BFC1C8] focus:shadow-[0_10px_30px_rgba(17,17,20,0.06)]"
            placeholder="Optional"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => submitFeedback("no", { reason: feedbackReason, text: feedbackText })}
              disabled={status === "submitting" || !feedbackReason}
              className="rounded-full bg-[#111114] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#2C2C30] disabled:cursor-default disabled:opacity-60"
            >
              {status === "submitting" ? "Submitting..." : "Submit"}
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
  disabled,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-full border px-4 py-2 text-sm font-medium transition disabled:cursor-default disabled:opacity-60",
        active
          ? "border-[#111114] bg-[#111114] text-white"
          : "border-[#E4E4EA] bg-white text-[#62626A] hover:border-[#C9CAD1] hover:text-[#111114]"
      )}
    >
      {children}
    </button>
  );
}
