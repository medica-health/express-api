export interface Slot {
  startAt: Date;
  endAt: Date;
  clinicId: string;
}

export interface Interval {
  startAt: Date;
  endAt: Date;
}

const overlaps = (a: Interval, b: Interval) => a.startAt < b.endAt && b.startAt < a.endAt;

/**
 * Removes slots that are in the past (or start within `minLeadMinutes`) or that overlap any
 * busy interval (booked appointments, time off). Returns slots sorted by start time.
 * Candidate slots are generated in SQL from the weekly availability rules, because that
 * needs the clinic's time zone.
 */
export function filterAvailableSlots(
  candidates: Slot[],
  busy: Interval[],
  now: Date = new Date(),
  minLeadMinutes = 0,
): Slot[] {
  const earliest = now.getTime() + minLeadMinutes * 60_000;
  return candidates
    .filter((s) => s.startAt.getTime() >= earliest)
    .filter((s) => !busy.some((b) => overlaps(s, b)))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}
