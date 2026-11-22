import { queryOne } from "../db";
import { layout, sendMail } from "./mailer.service";

// Appointment-related emails. Each function loads what it needs and is safe to call
// without awaiting (errors are caught and logged).

interface ApptMailRow {
  id: string;
  start_at: Date;
  timezone: string;
  clinic_name: string;
  clinic_address: string;
  patient_id: string;
  patient_name: string;
  patient_email: string;
  doctor_id: string;
  doctor_name: string;
  doctor_email: string;
  cancel_reason: string | null;
}

async function loadAppointment(id: string): Promise<ApptMailRow | undefined> {
  return queryOne<ApptMailRow>(
    `SELECT a.id, a.start_at, c.timezone, c.name AS clinic_name,
            c.address_line || ', ' || c.city AS clinic_address,
            p.id AS patient_id, p.full_name AS patient_name, p.email::text AS patient_email,
            d.id AS doctor_id, d.full_name AS doctor_name, d.email::text AS doctor_email,
            a.cancel_reason
       FROM app.appointments a
       JOIN app.clinics c ON c.id = a.clinic_id
       JOIN auth.users p ON p.id = a.patient_id
       JOIN auth.users d ON d.id = a.doctor_id
      WHERE a.id = $1`,
    [id],
  );
}

export function formatWhen(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeStyle: "short", timeZone }).format(date);
}

type Event = "BOOKED" | "CANCELLED" | "RESCHEDULED" | "REMINDER";

const SUBJECTS: Record<Event, string> = {
  BOOKED: "Appointment confirmed",
  CANCELLED: "Appointment cancelled",
  RESCHEDULED: "Appointment rescheduled",
  REMINDER: "Reminder: your upcoming appointment",
};

async function notify(appointmentId: string, event: Event): Promise<void> {
  const a = await loadAppointment(appointmentId);
  if (!a) return;
  const when = formatWhen(a.start_at, a.timezone);
  const where = `${a.clinic_name}, ${a.clinic_address}`;

  const patientLines: Record<Event, string[]> = {
    BOOKED: [`Hi ${a.patient_name},`, `Your appointment with Dr. ${a.doctor_name} is booked for ${when}.`, `Location: ${where}`],
    RESCHEDULED: [`Hi ${a.patient_name},`, `Your appointment with Dr. ${a.doctor_name} has moved to ${when}.`, `Location: ${where}`],
    CANCELLED: [
      `Hi ${a.patient_name},`,
      `Your appointment with Dr. ${a.doctor_name} on ${when} has been cancelled.`,
      ...(a.cancel_reason ? [`Reason: ${a.cancel_reason}`] : []),
    ],
    REMINDER: [`Hi ${a.patient_name},`, `This is a reminder of your appointment with Dr. ${a.doctor_name} on ${when}.`, `Location: ${where}`],
  };

  const subject = SUBJECTS[event];
  const lines = patientLines[event];
  const jobs = [
    sendMail({
      to: a.patient_email,
      subject,
      html: layout(subject, lines, { label: "View appointment", path: `/patient/appointments/${a.id}` }),
      text: lines.join("\n"),
      type: `APPOINTMENT_${event}`,
      userId: a.patient_id,
      appointmentId: a.id,
    }),
  ];

  // Doctors hear about new, moved and cancelled bookings (not reminders).
  if (event !== "REMINDER") {
    const doctorLines = [`Dr. ${a.doctor_name},`, `${a.patient_name}'s appointment on ${when} was ${event.toLowerCase()}.`];
    jobs.push(
      sendMail({
        to: a.doctor_email,
        subject: `${subject}: ${a.patient_name}`,
        html: layout(subject, doctorLines, { label: "Open schedule", path: `/doctor/appointments/${a.id}` }),
        text: doctorLines.join("\n"),
        type: `APPOINTMENT_${event}_DOCTOR`,
        userId: a.doctor_id,
        appointmentId: a.id,
      }),
    );
  }
  await Promise.all(jobs);
}

function fireAndForget(p: Promise<void>) {
  p.catch((err: Error) => console.error("Notification failed:", err.message));
}

export const notifyBooked = (id: string) => fireAndForget(notify(id, "BOOKED"));
export const notifyCancelled = (id: string) => fireAndForget(notify(id, "CANCELLED"));
export const notifyRescheduled = (id: string) => fireAndForget(notify(id, "RESCHEDULED"));
export const sendReminder = (id: string) => notify(id, "REMINDER");

export function notifyDoctorVerification(
  doctor: { id: string; email: string; full_name: string },
  status: "APPROVED" | "REJECTED",
  reason?: string | null,
) {
  const subject = status === "APPROVED" ? "Your doctor profile is approved" : "Your doctor profile needs changes";
  const lines =
    status === "APPROVED"
      ? [`Dr. ${doctor.full_name},`, "Your profile has been verified. Patients can now find and book you."]
      : [`Dr. ${doctor.full_name},`, "Your profile could not be approved.", ...(reason ? [`Reason: ${reason}`] : [])];
  fireAndForget(
    sendMail({
      to: doctor.email,
      subject,
      html: layout(subject, lines, { label: "Go to dashboard", path: "/doctor" }),
      text: lines.join("\n"),
      type: `DOCTOR_${status}`,
      userId: doctor.id,
    }),
  );
}
