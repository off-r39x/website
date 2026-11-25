import type { ContinuationNotice } from "./continuation-view";

/** The authentication-required notice. Plain text only; it is not a live region. */
export function ContinuationNoticeView({ notice }: { notice: ContinuationNotice | null }) {
  if (notice === null) return null;
  return (
    <div className="card measure">
      <p className="card__label">{notice.notice}</p>
      <p className="card__note">{notice.purposeLabel}</p>
      <p className="card__note">{notice.returnAfter}</p>
      <p className="card__note">{notice.revalidate}</p>
    </div>
  );
}
