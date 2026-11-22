-- Read-only role for the phone receptionist. LOGIN and the password are set per environment
-- (never in a migration).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receptionist_ro') THEN
    CREATE ROLE receptionist_ro NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA auth, app TO receptionist_ro;
GRANT SELECT (id, email, full_name, phone, role, enabled) ON auth.users TO receptionist_ro;
GRANT SELECT (user_id, date_of_birth) ON app.patient_profiles TO receptionist_ro;
