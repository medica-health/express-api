-- The phone receptionist no longer calls express-api or spring-api: it reads and writes the
-- shared database itself (receptionist/src/receptionist/backend). The read-only role from 004
-- becomes receptionist_app, with exactly the privileges those queries need. LOGIN and the
-- password are still set per environment (never in a migration).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receptionist_ro')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receptionist_app') THEN
    ALTER ROLE receptionist_ro RENAME TO receptionist_app;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receptionist_app') THEN
    CREATE ROLE receptionist_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA auth, app TO receptionist_app;

-- Caller lookup, doctor names, and registering new phone patients (spring-api's
-- PhonePatientService did this before). No access to tokens or other auth tables.
GRANT SELECT (id, email, full_name, phone, role, enabled) ON auth.users TO receptionist_app;
GRANT INSERT (email, password_hash, full_name, phone, role, enabled, email_verified)
  ON auth.users TO receptionist_app;

-- Verification (DOB), the saved search location, and saving a caller's DOB.
GRANT SELECT (user_id, date_of_birth, location) ON app.patient_profiles TO receptionist_app;
GRANT INSERT (user_id, date_of_birth) ON app.patient_profiles TO receptionist_app;
GRANT UPDATE (date_of_birth, updated_at) ON app.patient_profiles TO receptionist_app;

-- Directory and slot generation.
GRANT SELECT ON app.specializations, app.clinics, app.doctor_profiles, app.doctor_clinics,
  app.doctor_availability, app.doctor_time_off TO receptionist_app;

-- Booking, cancelling and rescheduling the caller's own appointments.
GRANT SELECT ON app.appointments TO receptionist_app;
GRANT INSERT (patient_id, doctor_id, clinic_id, booked_by, start_at, end_at, reason)
  ON app.appointments TO receptionist_app;
GRANT UPDATE (status, start_at, end_at, clinic_id, reason, cancel_reason, cancelled_by,
  cancelled_at, reminder_sent_at, updated_at) ON app.appointments TO receptionist_app;

-- Reading prescriptions back to the verified caller.
GRANT SELECT ON app.prescriptions, app.prescription_items TO receptionist_app;

-- Recording the confirmations it sends.
GRANT INSERT (user_id, appointment_id, type, channel, recipient, subject, status, error,
  provider_message_id) ON app.notifications_log TO receptionist_app;
GRANT USAGE ON SEQUENCE app.notifications_log_id_seq TO receptionist_app;
