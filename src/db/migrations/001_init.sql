-- express-api owns the `app` schema. User identities live in `auth.users`, owned by spring-api
-- (Flyway). This service only reads auth.users and references it with foreign keys.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- reference data
CREATE TABLE app.specializations (
  id          serial PRIMARY KEY,
  name        citext NOT NULL UNIQUE,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- clinics (PostGIS)
CREATE TABLE app.clinics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  address_line text NOT NULL,
  city         text NOT NULL,
  state        text NOT NULL,
  pincode      text NOT NULL,
  country      text NOT NULL DEFAULT 'India',
  phone        text,
  timezone     text NOT NULL DEFAULT 'Asia/Kolkata',
  location     geography(Point, 4326) NOT NULL,
  created_by   uuid NOT NULL REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clinics_location_gix ON app.clinics USING gist (location);
CREATE INDEX clinics_city_idx     ON app.clinics (lower(city));
CREATE INDEX clinics_state_idx    ON app.clinics (lower(state));
CREATE INDEX clinics_pincode_idx  ON app.clinics (pincode);

-- ---------------------------------------------------------------- profiles
CREATE TABLE app.doctor_profiles (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  specialization_id   int REFERENCES app.specializations(id),
  qualifications      text,
  registration_number text,
  experience_years    int NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
  consultation_fee    numeric(10, 2) NOT NULL DEFAULT 0 CHECK (consultation_fee >= 0),
  bio                 text,
  languages           text[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'PENDING'
                      CHECK (verification_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  rejection_reason    text,
  verified_by         uuid REFERENCES auth.users(id),
  verified_at         timestamptz,
  avg_rating          numeric(3, 2) NOT NULL DEFAULT 0,
  rating_count        int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctor_profiles_status_idx ON app.doctor_profiles (verification_status);
CREATE INDEX doctor_profiles_spec_idx   ON app.doctor_profiles (specialization_id);

CREATE TABLE app.doctor_clinics (
  doctor_id uuid NOT NULL REFERENCES app.doctor_profiles(user_id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES app.clinics(id) ON DELETE CASCADE,
  PRIMARY KEY (doctor_id, clinic_id)
);
CREATE INDEX doctor_clinics_clinic_idx ON app.doctor_clinics (clinic_id);

CREATE TABLE app.patient_profiles (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  date_of_birth           date,
  gender                  text CHECK (gender IN ('MALE', 'FEMALE', 'OTHER')),
  blood_group             text CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  allergies               text,
  chronic_conditions      text,
  address_line            text,
  city                    text,
  state                   text,
  pincode                 text,
  location                geography(Point, 4326),
  emergency_contact_name  text,
  emergency_contact_phone text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.receptionist_assignments (
  receptionist_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  doctor_id       uuid NOT NULL REFERENCES app.doctor_profiles(user_id) ON DELETE CASCADE,
  assigned_by     uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receptionist_id, doctor_id)
);
CREATE INDEX receptionist_assignments_doctor_idx ON app.receptionist_assignments (doctor_id);

-- ---------------------------------------------------------------- scheduling
-- Weekly recurring rules in the clinic's local time. day_of_week: 0 = Sunday ... 6 = Saturday.
CREATE TABLE app.doctor_availability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id    uuid NOT NULL REFERENCES app.doctor_profiles(user_id) ON DELETE CASCADE,
  clinic_id    uuid NOT NULL REFERENCES app.clinics(id) ON DELETE CASCADE,
  day_of_week  smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  slot_minutes smallint NOT NULL DEFAULT 15 CHECK (slot_minutes BETWEEN 5 AND 240),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  -- a doctor can't be in two places at once on the same weekday
  CONSTRAINT doctor_availability_no_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    day_of_week WITH =,
    tsrange(DATE '2000-01-01' + start_time, DATE '2000-01-01' + end_time) WITH &&
  ) WHERE (is_active)
);

CREATE TABLE app.doctor_time_off (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id  uuid NOT NULL REFERENCES app.doctor_profiles(user_id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX doctor_time_off_doctor_idx ON app.doctor_time_off (doctor_id, starts_at);

-- ---------------------------------------------------------------- appointments
CREATE TABLE app.appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES auth.users(id),
  doctor_id        uuid NOT NULL REFERENCES app.doctor_profiles(user_id),
  clinic_id        uuid NOT NULL REFERENCES app.clinics(id),
  booked_by        uuid NOT NULL REFERENCES auth.users(id),
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'BOOKED'
                   CHECK (status IN ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  reason           text,
  doctor_notes     text,
  cancel_reason    text,
  cancelled_by     uuid REFERENCES auth.users(id),
  cancelled_at     timestamptz,
  checked_in_at    timestamptz,
  completed_at     timestamptz,
  reminder_sent_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- no double booking of a doctor, and no overlapping appointments for a patient
  CONSTRAINT appointments_doctor_no_overlap EXCLUDE USING gist (
    doctor_id WITH =, tstzrange(start_at, end_at) WITH &&
  ) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW')),
  CONSTRAINT appointments_patient_no_overlap EXCLUDE USING gist (
    patient_id WITH =, tstzrange(start_at, end_at) WITH &&
  ) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'))
);
CREATE INDEX appointments_doctor_start_idx  ON app.appointments (doctor_id, start_at);
CREATE INDEX appointments_patient_start_idx ON app.appointments (patient_id, start_at);
CREATE INDEX appointments_reminder_idx      ON app.appointments (start_at)
  WHERE reminder_sent_at IS NULL AND status IN ('BOOKED', 'CONFIRMED');

-- ---------------------------------------------------------------- clinical
CREATE TABLE app.prescriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES app.appointments(id) ON DELETE CASCADE,
  doctor_id      uuid NOT NULL REFERENCES app.doctor_profiles(user_id),
  patient_id     uuid NOT NULL REFERENCES auth.users(id),
  diagnosis      text NOT NULL,
  notes          text,
  advice         text,
  follow_up_date date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_patient_idx ON app.prescriptions (patient_id, created_at DESC);

CREATE TABLE app.prescription_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id uuid NOT NULL REFERENCES app.prescriptions(id) ON DELETE CASCADE,
  medicine        text NOT NULL,
  dosage          text NOT NULL,
  frequency       text NOT NULL,
  duration        text NOT NULL,
  instructions    text,
  position        smallint NOT NULL DEFAULT 0
);
CREATE INDEX prescription_items_rx_idx ON app.prescription_items (prescription_id, position);

-- File bytes live in MongoDB GridFS; Postgres keeps the metadata and access rules.
CREATE TABLE app.medical_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id     uuid NOT NULL REFERENCES auth.users(id),
  uploaded_by    uuid NOT NULL REFERENCES auth.users(id),
  appointment_id uuid REFERENCES app.appointments(id) ON DELETE SET NULL,
  title          text NOT NULL,
  record_type    text NOT NULL DEFAULT 'OTHER'
                 CHECK (record_type IN ('LAB_REPORT', 'IMAGING', 'PRESCRIPTION', 'DISCHARGE_SUMMARY', 'OTHER')),
  description    text,
  file_name      text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     int NOT NULL,
  gridfs_file_id text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medical_records_patient_idx ON app.medical_records (patient_id, created_at DESC);

CREATE TABLE app.reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES app.appointments(id) ON DELETE CASCADE,
  doctor_id      uuid NOT NULL REFERENCES app.doctor_profiles(user_id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL REFERENCES auth.users(id),
  rating         smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_doctor_idx ON app.reviews (doctor_id, created_at DESC);

-- ---------------------------------------------------------------- notifications
CREATE TABLE app.notifications_log (
  id             bigserial PRIMARY KEY,
  user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES app.appointments(id) ON DELETE SET NULL,
  type           text NOT NULL,
  recipient      text NOT NULL,
  subject        text NOT NULL,
  status         text NOT NULL CHECK (status IN ('SENT', 'FAILED', 'SKIPPED')),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_log_user_idx ON app.notifications_log (user_id, created_at DESC);
