# express-api

Domain API for the MediCare online doctor appointment system: doctor discovery (PostGIS "near me" and city search), scheduling, appointments, prescriptions, medical records, reviews, admin and email notifications.

- **Runtime:** Bun runs the TypeScript directly, Express 5.
- **Auth:** JWTs (HS256) issued by `spring-api`. This service only verifies them (`jose`) and enforces role-based access control.
- **Data:**
  - **PostgreSQL + PostGIS** is the main database. This service owns the `app` schema and only reads `auth.users`, which `spring-api` owns.
  - **MongoDB** stores medical-record files (GridFS bucket `medical_records`) and the `audit_logs` collection.
- **Email:** sent via **Resend** (`resend` SDK) for bookings, cancellations, reschedules, doctor verification and 24-hour reminders. Reminders use Resend idempotency keys, rate-limit errors are retried with backoff, and every attempt is logged in `app.notifications_log` with the Resend message id. Without `RESEND_API_KEY`, emails are only logged (status `SKIPPED`).

## Running locally

```bash
bun install
cp .env.example .env        # then set JWT_SECRET (same value as spring-api)
bun run dev                 # http://localhost:5000
```

The full stack (PostGIS, Mongo, both APIs, client) runs from the workspace root:

```bash
docker compose -f .github/docker-compose.yml --project-directory . up --build
```

On startup the API applies pending SQL migrations from `src/db/migrations/`. They are tracked in `app.schema_migrations`, and a Postgres advisory lock keeps two pods from migrating at once.

The migrations reference `auth.users`, so **spring-api must have run its Flyway migrations first**. Compose handles the ordering.

| Script | What it does |
|---|---|
| `bun run dev` | Watch mode |
| `bun run lint` / `bun run typecheck` | ESLint / TS 7 (`@typescript/native`) |
| `bun test` | Unit and HTTP tests. They need no database. |
| `bun run migrate` | Apply migrations and exit |
| `bun run seed` | **Dev only.** Loads demo users, clinics in Pune, Mumbai, Delhi and Bengaluru, doctors and availability. Every demo password is `Password@123`. |
| `bun run token -- --email doctor1@demo.local` | **Dev only.** Mints an access token for a seeded user, the way spring-api will |

## Roles and access

The `role` claim is one of `PATIENT`, `DOCTOR`, `RECEPTIONIST` or `ADMIN`. Access is checked in two layers:
- `requireRole(...)` on each route.
- Record-level policies in `src/policies/` and `services/access.service.ts`: ownership, receptionist ↔ doctor assignments, and "has treated this patient".

| Capability | Patient | Doctor | Receptionist | Admin |
|---|---|---|---|---|
| Search doctors, see slots | ✓ | ✓ | ✓ | ✓ (public) |
| Book | self | – | assigned doctors | any |
| Cancel / reschedule | own, ≥2h before | own | assigned doctors | any |
| Confirm / check-in / no-show | – | own | assigned doctors | any |
| Complete, write prescription | – | own | – | – |
| Availability, time off, clinics | – | own | assigned doctors | any |
| Prescriptions & records | own | patients they treated | – | – |
| Review a doctor | completed appts, once | – | – | delete |
| Verify doctors, specializations, assignments, stats | – | – | – | ✓ |

**Appointment status flow:**
- `BOOKED → CONFIRMED → CHECKED_IN → COMPLETED`
- `BOOKED | CONFIRMED → CANCELLED`
- `BOOKED | CONFIRMED → NO_SHOW` (only after the start time)

**Double booking** is prevented in the database by exclusion constraints on `tstzrange(start_at, end_at)`, per doctor and per patient. A conflict returns `409`.

## API

Every response uses the envelope `{ success, message, data, timestamp }`. Send authenticated requests with `Authorization: Bearer <token>`. In paths, `me` stands for the caller.

| Method & path | Who |
|---|---|
| `GET /api/doctors?lat&lng&radiusKm` or `?city&state&pincode`, plus `specializationId, q, language, minFee, maxFee, minRating, sort=distance\|rating\|fee\|experience, page, limit` | public |
| `GET /api/doctors/:id`, `/:id/slots?date=YYYY-MM-DD&clinicId`, `/:id/reviews` | public |
| `GET/PUT /api/doctors/me/profile` | doctor |
| `GET /api/doctors/:doctorId/clinics`, `PUT/DELETE /api/doctors/:doctorId/clinics/:clinicId` | doctor / receptionist / admin |
| `GET/POST /api/doctors/:doctorId/availability`, `PUT/DELETE …/availability/:id` | doctor / receptionist / admin |
| `GET/POST /api/doctors/:doctorId/time-off`, `DELETE …/time-off/:id` | doctor / receptionist / admin |
| `GET /api/clinics?lat&lng&radiusKm&city&q`, `GET /api/clinics/:id` | public |
| `POST /api/clinics`, `PATCH /api/clinics/:id` | doctor (own) / admin |
| `DELETE /api/clinics/:id` | admin |
| `GET /api/specializations` | public |
| `POST /api/appointments` | patient / receptionist / admin |
| `GET /api/appointments?status&from&to&doctorId&patientId&clinicId`, `GET /api/appointments/:id` | all (scoped) |
| `PATCH /api/appointments/:id/status`, `POST /:id/cancel`, `POST /:id/reschedule` | per status flow |
| `PUT/GET /api/appointments/:id/prescription` | doctor writes; patient / treating doctor read |
| `POST /api/appointments/:id/review` | patient |
| `GET/PUT /api/patients/me/profile` | patient |
| `GET /api/patients/lookup?email=` | receptionist / admin |
| `GET /api/patients?q=` | doctor / receptionist |
| `GET /api/patients/:patientId/summary`, `/:patientId/prescriptions`, `GET /api/prescriptions/:id` | patient / treating doctor |
| `POST /api/medical-records` (multipart `file` + `title, recordType, description, appointmentId, patientId`) | patient / treating doctor |
| `GET /api/medical-records?patientId`, `GET /:id/download`, `DELETE /:id` | patient / treating doctor |
| `GET /api/dashboard/me` | all |
| `GET /api/admin/stats`, `/admin/audit-logs`, `/admin/doctors?status`, `PATCH /admin/doctors/:id/verification` | admin |
| `POST/PUT/DELETE /api/admin/specializations[/:id]`, `GET/POST/DELETE /api/admin/assignments`, `DELETE /api/admin/reviews/:id` | admin |

## Layout

```
src/
  app.ts, server.ts         app factory (used by tests) / process entry
  config/                   env (zod-validated), postgres pool, mongo
  db/                       query helpers, withTransaction, migration runner, migrations/*.sql
  middlewares/              authenticate, requireRole, validate, errorHandler
  policies/                 pure rules: status machine, access, slot filtering
  validators/               zod schemas per module
  routes/ → controllers/ → services/
  jobs/reminders.ts         24h reminder sweep (node-cron, multi-replica safe)
  scripts/                  migrate, seed, dev-token
  test/                     bun test
```
