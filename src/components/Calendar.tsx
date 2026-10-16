import Link from "next/link";
import { format } from "date-fns";
import type { CalendarEvent } from "@/lib/events";
import { CHECKING_COLOR, STATUS, seriesColor } from "@/lib/colors";
import { cx } from "./ui";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function eventColor(e: CalendarEvent): string {
  if (e.type === "autopay" && e.severity === "overdraft") return STATUS.critical;
  if (e.type === "autopay" && e.severity === "tight") return STATUS.warning;
  return e.colorSlot == null ? CHECKING_COLOR : seriesColor(e.colorSlot);
}

function Marker({ event }: { event: CalendarEvent }) {
  const color = eventColor(event);
  if (event.type === "autopay") {
    return <span className="size-2 rotate-45" style={{ backgroundColor: color }} />;
  }
  if (event.type === "payment" || event.type === "paid-off") {
    return <span className="size-2 rounded-full border-[1.5px]" style={{ borderColor: color }} />;
  }
  return <span className="size-2 rounded-full" style={{ backgroundColor: color }} />;
}

export function MonthCalendar({
  year,
  monthIndex,
  events,
  todayISO,
  prevHref,
  nextHref,
}: {
  year: number;
  monthIndex: number;
  events: CalendarEvent[];
  todayISO: string;
  prevHref: string;
  nextHref: string;
}) {
  const first = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const offset = first.getDay();

  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.dateISO) ?? [];
    list.push(e);
    byDate.set(e.dateISO, list);
  }

  const cells: (number | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const iso = (day: number) =>
    `${year}-${`${monthIndex + 1}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">{format(first, "MMMM yyyy")}</p>
        <div className="flex gap-1">
          <Link
            href={prevHref}
            aria-label="Previous month"
            className="rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-page"
          >
            ←
          </Link>
          <Link
            href={nextHref}
            aria-label="Next month"
            className="rounded-md border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-page"
          >
            →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-hairline bg-hairline">
        {WEEKDAYS.map((d) => (
          <div key={d} className="bg-page px-1 py-1 text-center text-[10px] font-semibold uppercase text-muted">
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <div key={`empty-${i}`} className="min-h-14 bg-surface" />;
          const dayISO = iso(day);
          const dayEvents = byDate.get(dayISO) ?? [];
          const hasAlert = dayEvents.some((e) => e.severity !== "ok");
          const isToday = dayISO === todayISO;
          return (
            <div key={dayISO} className={cx("min-h-14 bg-surface p-1.5", isToday && "bg-accent-wash")}>
              <span
                className={cx(
                  "inline-flex size-5 items-center justify-center rounded-full text-[11px]",
                  isToday ? "bg-accent font-semibold text-white" : "text-ink-2",
                  hasAlert && !isToday && "ring-1 ring-critical"
                )}
              >
                {day}
              </span>
              {dayEvents.length > 0 && (
                <span className="mt-1 flex flex-wrap items-center gap-1" title={dayEvents.map((e) => e.label).join(", ")}>
                  {dayEvents.slice(0, 4).map((e, j) => (
                    <Marker key={j} event={e} />
                  ))}
                  {dayEvents.length > 4 && <span className="text-[9px] text-muted">+{dayEvents.length - 4}</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-ink-2" /> Balance updated
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full border-[1.5px] border-ink-2" /> Payment
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rotate-45 bg-ink-2" /> Auto pay ahead
        </span>
      </div>

      {events.length > 0 && (
        <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto border-t border-hairline pt-3 text-sm">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2.5 rounded-md px-1 py-1">
              <span className="mt-1 flex w-4 justify-center">
                <Marker event={e} />
              </span>
              <span className="money w-14 shrink-0 pt-px text-xs text-muted">
                {format(new Date(`${e.dateISO}T00:00:00`), "MMM d")}
              </span>
              <span className="min-w-0">
                <span className={cx("block leading-tight", e.severity !== "ok" ? "font-medium text-critical" : "text-ink")}>
                  {e.label}
                </span>
                <span className="block text-xs text-ink-2">{e.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
