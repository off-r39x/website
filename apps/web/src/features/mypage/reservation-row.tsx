import { copy } from "../../presentation/copy/ja";
import { Link } from "../../routing/link";
import type { ReservationRow } from "./reservation-model";

// One Reservation of a Mypage list (PG-MYP-001 / 008). The Reservation state and the Karaoke Ticket
// state are two separate texts: a used Ticket is a Ticket state, never a Reservation state.

export function ReservationRowView({ row }: { row: ReservationRow }) {
  return (
    <li className="card items-start">
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <p className="flex flex-col">
          <span className="card__label">{copy.mypage.reservations.dateLabel}</span>{" "}
          <span className="card__value num">{row.dateText}</span>
        </p>
        <p className="flex flex-col">
          <span className="card__label">{copy.mypage.reservations.timeLabel}</span>{" "}
          <span className="card__value num">{row.timeText}</span>
        </p>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <p className="flex flex-col">
          <span className="card__label">{copy.mypage.reservations.reservationStateLabel}</span>{" "}
          {row.reservationLabel}
        </p>
        <p className="flex flex-col">
          <span className="card__label">{copy.mypage.reservations.ticketStateLabel}</span>{" "}
          {row.ticketLabel}
        </p>
      </div>
      <Link href={row.href} prefetch={false} className="link inline-flex min-h-11 items-center">
        {row.linkLabel}
      </Link>
    </li>
  );
}
