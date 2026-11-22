import cron, { type ScheduledTask } from "node-cron";
import { query } from "../db";
import { sendReminder } from "../services/notifications.service";

/**
 * Claims appointments starting in the next 24h that haven't been reminded yet.
 * The UPDATE ... FOR UPDATE SKIP LOCKED claim is atomic, so several API replicas can run
 * this job at the same time without sending duplicate emails.
 */
export async function runReminderSweep(): Promise<number> {
  const claimed = await query<{ id: string }>(
    `UPDATE app.appointments SET reminder_sent_at = now()
      WHERE id IN (
        SELECT id FROM app.appointments
         WHERE status IN ('BOOKED', 'CONFIRMED')
           AND reminder_sent_at IS NULL
           AND start_at > now() AND start_at <= now() + interval '24 hours'
         ORDER BY start_at
         LIMIT 200
         FOR UPDATE SKIP LOCKED)
      RETURNING id`,
  );
  for (const { id } of claimed) {
    await sendReminder(id).catch((err: Error) => console.error(`Reminder for ${id} failed:`, err.message));
  }
  return claimed.length;
}

let task: ScheduledTask | null = null;

export function startJobs(): void {
  task = cron.schedule("*/15 * * * *", async () => {
    try {
      const sent = await runReminderSweep();
      if (sent) console.log(`Sent ${sent} appointment reminder(s)`);
    } catch (err) {
      console.error("Reminder sweep failed:", (err as Error).message);
    }
  });
  console.log("Background jobs started (appointment reminders every 15 min)");
}

export function stopJobs(): void {
  task?.stop();
}
