"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ExternalLink } from "lucide-react";
import type { ContenderAction } from "@/lib/types";

type ContenderActionLinkProps = {
  action: ContenderAction;
  actionType?: "link" | "button";
  category?: string | null;
  className?: string;
  consensusMode?: string | null;
  contenderName: string;
  displayPosition: number;
  onPreviewAction?: (action: ContenderAction) => void;
  searchId?: string | null;
  searchQuery?: string | null;
};

export function ContenderActionLink({
  action,
  actionType = "button",
  category,
  className,
  consensusMode,
  contenderName,
  displayPosition,
  onPreviewAction,
  searchId,
  searchQuery
}: ContenderActionLinkProps) {
  const impressionRecordedRef = useRef(false);
  const [useDirectMobileMapsNavigation, setUseDirectMobileMapsNavigation] = useState(false);

  useEffect(() => {
    if (impressionRecordedRef.current) {
      return;
    }

    impressionRecordedRef.current = true;
    recordContenderActionEvent("contender_action_impression", {
      action,
      category,
      consensusMode,
      contenderName,
      displayPosition,
      searchId,
      searchQuery
    });
  }, [action, category, consensusMode, contenderName, displayPosition, searchId, searchQuery]);

  useEffect(() => {
    if (action.type !== "maps" || !onPreviewAction) {
      return;
    }

    const mediaQuery = window.matchMedia("(hover: none), (pointer: coarse)");
    const updateNavigationMode = () => setUseDirectMobileMapsNavigation(mediaQuery.matches);

    updateNavigationMode();
    mediaQuery.addEventListener("change", updateNavigationMode);

    return () => mediaQuery.removeEventListener("change", updateNavigationMode);
  }, [action.type, onPreviewAction]);

  const baseClassName =
    actionType === "link"
      ? "inline-flex items-center gap-1.5 text-sm font-medium text-[#4B4B52] transition hover:text-[#111114]"
      : "inline-flex items-center gap-2 rounded-full border border-[#E2E2E7] bg-white px-4 py-2.5 text-sm font-medium text-[#111114] transition hover:border-[#CFCFD6] hover:bg-[#F8F8FA]";
  const shouldOpenPreview = Boolean(onPreviewAction && !useDirectMobileMapsNavigation);

  return (
    <a
      className={className ?? baseClassName}
      href={action.url}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        recordContenderActionEvent("contender_action_click", {
          action,
          category,
          consensusMode,
          contenderName,
          displayPosition,
          searchId,
          searchQuery
        });

        if (shouldOpenPreview && onPreviewAction) {
          event.preventDefault();
          onPreviewAction(action);
        }
      }}
      rel={useDirectMobileMapsNavigation ? undefined : "noopener noreferrer"}
      target={useDirectMobileMapsNavigation ? undefined : "_blank"}
    >
      {action.label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

type ActionEventType = "contender_action_impression" | "contender_action_click";

type ActionEventMetadata = {
  action: ContenderAction;
  category?: string | null;
  consensusMode?: string | null;
  contenderName: string;
  displayPosition: number;
  searchId?: string | null;
  searchQuery?: string | null;
};

function recordContenderActionEvent(eventType: ActionEventType, metadata: ActionEventMetadata) {
  const payload = JSON.stringify({
    eventType,
    searchId: metadata.searchId ?? null,
    searchQuery: metadata.searchQuery ?? null,
    category: metadata.category ?? null,
    consensusMode: metadata.consensusMode ?? null,
    contenderName: metadata.contenderName,
    actionType: metadata.action.type,
    displayPosition: metadata.displayPosition,
    destinationDomain: metadata.action.domain
  });

  if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    const sent = navigator.sendBeacon("/api/contender-action", new Blob([payload], { type: "application/json" }));

    if (sent) {
      return;
    }
  }

  void fetch("/api/contender-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => undefined);
}
