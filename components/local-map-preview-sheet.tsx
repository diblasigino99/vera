"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe2, MapPin, X } from "lucide-react";
import type { ContenderAction } from "@/lib/types";

type LocalMapPreviewSheetProps = {
  businessName: string;
  mapsAction: ContenderAction;
  onClose: () => void;
  verifiedAddress?: string;
  websiteAction?: ContenderAction;
};

export function LocalMapPreviewSheet({
  businessName,
  mapsAction,
  onClose,
  verifiedAddress,
  websiteAction
}: LocalMapPreviewSheetProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const embedUrl = verifiedAddress
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${businessName} ${verifiedAddress}`)}&output=embed`
    : null;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scrollY = window.scrollY;
    const previousBodyStyles = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      touchAction: document.body.style.touchAction
    };

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.touchAction = "none";
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyStyles.overflow;
      document.body.style.position = previousBodyStyles.position;
      document.body.style.top = previousBodyStyles.top;
      document.body.style.width = previousBodyStyles.width;
      document.body.style.touchAction = previousBodyStyles.touchAction;
      window.scrollTo(0, scrollY);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center px-3 pb-3 pt-10 sm:items-center sm:p-6">
      <button
        aria-label="Close map preview"
        className="absolute inset-0 bg-[#111114]/28"
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby="local-map-preview-title"
        aria-modal="true"
        className="relative z-10 w-full max-w-[28rem] overflow-hidden rounded-t-[1.5rem] border border-[#E7E7EC] bg-white shadow-[0_24px_80px_rgba(17,17,20,0.18)] sm:rounded-[1.5rem]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-[#111114]" id="local-map-preview-title">
              {businessName}
            </h2>
            {verifiedAddress ? <p className="mt-1 text-sm leading-6 text-[#66666D]">{verifiedAddress}</p> : null}
          </div>
          <button
            aria-label="Close map preview"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#E6E6EB] bg-white text-[#4B4B52] transition hover:border-[#D2D2D9] hover:bg-[#F8F8FA]"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 sm:px-6">
          <div className="relative h-40 overflow-hidden rounded-[1rem] border border-[#E6E6EB] bg-[#F5F5F7] sm:h-44">
            {embedUrl && !mapFailed ? (
              <iframe
                className="h-full w-full border-0"
                loading="lazy"
                onError={() => setMapFailed(true)}
                referrerPolicy="no-referrer-when-downgrade"
                src={embedUrl}
                title={`Map preview for ${businessName}`}
              />
            ) : (
              <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(226,226,231,0.72)_1px,transparent_1px),linear-gradient(0deg,rgba(226,226,231,0.72)_1px,transparent_1px)] bg-[size:28px_28px]" />
            )}
            <div className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-[#111114] text-white shadow-[0_10px_26px_rgba(17,17,20,0.24)]">
              <MapPin className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 px-5 pb-5 pt-4 sm:flex-row sm:px-6 sm:pb-6">
          <a
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[#111114] px-4 text-center text-sm font-medium text-white transition hover:bg-[#2C2C30]"
            href={mapsAction.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open in Google Maps
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          {websiteAction ? (
            <a
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-[#E2E2E7] bg-white px-4 text-sm font-medium text-[#111114] transition hover:border-[#CFCFD6] hover:bg-[#F8F8FA]"
              href={websiteAction.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
              Website
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}
