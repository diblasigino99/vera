"use client";

import { useState } from "react";
import type { ContenderAction } from "@/lib/types";
import { ContenderActionLink } from "@/components/contender-action-link";
import { LocalMapPreviewSheet } from "@/components/local-map-preview-sheet";

type ContenderActionsWithMapPreviewProps = {
  actions: ContenderAction[];
  actionType?: "link" | "button";
  category?: string | null;
  className?: string;
  consensusMode?: string | null;
  contenderName: string;
  displayPosition: number;
  searchId?: string | null;
  searchQuery?: string | null;
  verifiedAddress?: string;
};

export function ContenderActionsWithMapPreview({
  actions,
  actionType = "button",
  category,
  className,
  consensusMode,
  contenderName,
  displayPosition,
  searchId,
  searchQuery,
  verifiedAddress
}: ContenderActionsWithMapPreviewProps) {
  const [previewAction, setPreviewAction] = useState<ContenderAction | null>(null);
  const websiteAction = actions.find(
    (action) => action.type === "website" || action.type === "visit_website" || action.type === "view_website"
  );

  return (
    <>
      {actions.map((action) => (
        <ContenderActionLink
          action={action}
          actionType={actionType}
          category={category}
          className={className}
          consensusMode={consensusMode}
          contenderName={contenderName}
          displayPosition={displayPosition}
          key={`${action.type}:${action.url}`}
          onPreviewAction={action.type === "maps" ? setPreviewAction : undefined}
          searchId={searchId}
          searchQuery={searchQuery}
        />
      ))}
      {previewAction ? (
        <LocalMapPreviewSheet
          businessName={contenderName}
          mapsAction={previewAction}
          onClose={() => setPreviewAction(null)}
          verifiedAddress={verifiedAddress}
          websiteAction={websiteAction}
        />
      ) : null}
    </>
  );
}
