"use client";

import { useTransition } from "react";
import { archiveCard } from "@/lib/actions";
import { buttonStyles } from "./ui";

export function ArchiveCardButton({ cardId, cardName }: { cardId: string; cardName: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={buttonStyles.danger}
      onClick={() => {
        if (window.confirm(`Archive ${cardName}? Its history is kept, but it leaves the dashboard and predictions.`)) {
          startTransition(() => archiveCard(cardId));
        }
      }}
    >
      {pending ? "Archiving…" : "Archive card"}
    </button>
  );
}
