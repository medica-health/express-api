# express-api

Domain API for the MediCare online doctor appointment system: doctor discovery (PostGIS "near me" and city search), scheduling, appointments, prescriptions, medical records, reviews, admin and email notifications.

- **Runtime:** Bun runs the TypeScript directly, Express 5.
- **Auth:** JWTs (HS256) issued by `spring-api`. This service only verifies them (`jose`) and enforces role-based access control.
- **Data:**
  - **PostgreSQL + PostGIS** is the main database. This service owns the `app` schema and only reads `auth.users`, which `spring-api` owns.
  - **MongoDB** stores medical-record files (GridFS bucket `medical_records`) and the `audit_logs` collection.
- **Redis** (optional): slot holds, the free-slot cache and rate limiting. See [Slot booking and Redis](#slot-booking-and-redis).
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
| `bun test` | Unit and HTTP tests. They need no database. Set `TEST_REDIS_URL=redis://localhost:6379/15` to also run the Redis tests against a real (disposable) Redis; CI does. |
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

## Slot booking and Redis

Booking flow for the client:
1. `GET /api/doctors/:id/slots?date=` lists free slots. Each has `held` and `heldUntil`. A slot is `held` while another user is holding it; your own hold is not flagged.
2. `POST /api/appointments/holds { doctorId, clinicId, startAt }` holds the picked slot for `SLOT_HOLD_TTL_SECONDS` (default 5 min) and returns `{ holdId, expiresAt }`. Show a countdown.
   - `409` (with `heldUntil`): someone else holds it, or it was just booked. Pick another slot.
   - `503`: Redis is unavailable. Skip the hold and book directly.
3. `POST /api/appointments` books it. The hold is released automatically. Other users get `409` while the slot is held.
4. `DELETE /api/appointments/holds/:holdId` releases the hold if the user backs out. `GET /api/appointments/holds/me` returns the current hold (or `null`), e.g. after a page reload.

How it works (`services/slotHolds.service.ts`, `slotCache.service.ts`, `middlewares/rateLimit.ts`):
- **Holds** live in a sorted set per doctor and are created by a Lua script, so checking and holding is one atomic step: of many users racing for a slot, exactly one gets it. Holds compare time ranges, not start times, and expire on Redis' clock. Each user holds **one slot at a time**; holding another releases the previous one, so nobody can hoard a calendar. Patients, receptionists (assigned doctors) and admins can hold, the same as booking.
- **Free-slot cache**, per doctor, date and clinic, with a `SLOT_CACHE_TTL_SECONDS` (default 60 s) TTL. Every change that affects a doctor's free slots bumps that doctor's cache version after it commits: booking, cancel, reschedule, no-show, availability, time off, clinic links and clinic timezone changes. A version read before the Postgres query means a concurrent write can't leave a stale entry behind.
- **Rate limits** per user, shared across replicas: holds 30/min, bookings 20/min, cancel and reschedule 20/min. Responses carry `RateLimit-*` headers; over the limit returns `429` with `Retry-After`.
- **Redis is never the source of truth.** Postgres still checks the exact slot and its exclusion constraints still block overlaps. If Redis is down or `REDIS_URL` is empty, slots are read straight from Postgres, rate limits are skipped, holds return `503`, and booking keeps working. `/api/health` reports `redis` as `up`, `down` or `disabled`.
- The hold scripts touch keys of two doctors (when a user moves their hold), so use a **single-node** Redis (ElastiCache with cluster mode off), not Redis Cluster.

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
| `POST /api/appointments/holds`, `GET /holds/me`, `DELETE /holds/:holdId` | patient / receptionist / admin |
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
  config/                   env (zod-validated), postgres pool, mongo, redis (optional)
  db/                       query helpers, withTransaction, migration runner, migrations/*.sql
  middlewares/              authenticate, requireRole, validate, rateLimit, errorHandler
  policies/                 pure rules: status machine, access, slot filtering
  validators/               zod schemas per module
  routes/ → controllers/ → services/
  jobs/reminders.ts         24h reminder sweep (node-cron, multi-replica safe)
  scripts/                  migrate, seed, dev-token
  test/                     bun test
```
