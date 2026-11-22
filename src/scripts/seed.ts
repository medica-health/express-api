import "dotenv/config"; // must be first
import { pool } from "../config/postgres";
import { query, queryOne, withTransaction } from "../db";
import { runMigrations } from "../db/migrate";
import { POINT_SQL } from "../utils/geo";

// DEV ONLY: idempotent demo data. Users are written straight into auth.users here only
// because spring-api's register endpoint doesn't exist yet. In real use, accounts are
// created through spring-api.
//
// Every demo account has the password: Password@123
if (process.env.NODE_ENV === "production") {
  console.error("seed is disabled when NODE_ENV=production");
  process.exit(1);
}

const PASSWORD = "Password@123";

const SPECIALIZATIONS = [
  ["General Physician", "Primary care and common illnesses"],
  ["Cardiologist", "Heart and blood vessels"],
  ["Dermatologist", "Skin, hair and nails"],
  ["Pediatrician", "Children's health"],
  ["Orthopedist", "Bones, joints and muscles"],
  ["Gynecologist", "Women's reproductive health"],
  ["ENT Specialist", "Ear, nose and throat"],
  ["Psychiatrist", "Mental health"],
  ["Dentist", "Teeth and oral health"],
  ["Neurologist", "Brain and nervous system"],
] as const;

// [name, address, city, state, pincode, lat, lng]
const CLINICS = [
  ["Sahyadri Care Clinic", "FC Road, Shivajinagar", "Pune", "Maharashtra", "411005", 18.5236, 73.8478],
  ["Kothrud Family Health", "Karve Road, Kothrud", "Pune", "Maharashtra", "411038", 18.5074, 73.8077],
  ["Hinjewadi Wellness Centre", "Phase 1, Hinjewadi", "Pune", "Maharashtra", "411057", 18.5913, 73.7389],
  ["Bandra Heart & Health", "Hill Road, Bandra West", "Mumbai", "Maharashtra", "400050", 19.0544, 72.8406],
  ["Andheri City Clinic", "Link Road, Andheri West", "Mumbai", "Maharashtra", "400053", 19.1364, 72.8296],
  ["Connaught Medical Centre", "Block A, Connaught Place", "New Delhi", "Delhi", "110001", 28.6315, 77.2167],
  ["Koramangala Health Hub", "80 Feet Road, Koramangala", "Bengaluru", "Karnataka", "560034", 12.9352, 77.6245],
] as const;

// [name, email, specialization, fee, years, clinic indexes, status]
const DOCTORS = [
  ["Dr. Ananya Kulkarni", "doctor1@demo.local", "General Physician", 500, 9, [0, 1], "APPROVED"],
  ["Dr. Rohan Deshpande", "doctor2@demo.local", "Cardiologist", 1200, 15, [0], "APPROVED"],
  ["Dr. Meera Iyer", "doctor3@demo.local", "Dermatologist", 800, 7, [2], "APPROVED"],
  ["Dr. Arjun Mehta", "doctor4@demo.local", "Pediatrician", 700, 11, [3, 4], "APPROVED"],
  ["Dr. Kavya Reddy", "doctor5@demo.local", "Orthopedist", 1000, 13, [6], "APPROVED"],
  ["Dr. Vikram Singh", "doctor6@demo.local", "Neurologist", 1500, 18, [5], "APPROVED"],
  ["Dr. Sneha Patil", "doctor7@demo.local", "Gynecologist", 900, 6, [1], "PENDING"],
] as const;

const PATIENTS = [
  ["Rahul Sharma", "patient1@demo.local", 18.5204, 73.8567, "Pune"],
  ["Priya Nair", "patient2@demo.local", 19.076, 72.8777, "Mumbai"],
  ["Amit Verma", "patient3@demo.local", 28.6139, 77.209, "New Delhi"],
] as const;

async function upsertUser(email: string, fullName: string, role: string, hash: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO auth.users (email, password_hash, full_name, phone, role, enabled, email_verified)
     VALUES ($1, $2, $3, $4, $5, true, true)
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`,
    [email, hash, fullName, "+91 98765 43210", role],
  );
  return row!.id;
}

try {
  await runMigrations();
  // Same bcrypt format ($2b$) that Spring's BCryptPasswordEncoder verifies.
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 10 });

  await withTransaction(async (tx) => {
    for (const [name, description] of SPECIALIZATIONS) {
      await query(
        "INSERT INTO app.specializations (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
        [name, description],
        tx,
      );
    }
  });

  const adminId = await upsertUser("admin@demo.local", "Platform Admin", "ADMIN", hash);
  const receptionistId = await upsertUser("reception@demo.local", "Neha Joshi", "RECEPTIONIST", hash);

  const clinicIds: string[] = [];
  for (const [name, address, city, state, pincode, lat, lng] of CLINICS) {
    const existing = await queryOne<{ id: string }>("SELECT id FROM app.clinics WHERE name = $1", [name]);
    const row =
      existing ??
      (await queryOne<{ id: string }>(
        `INSERT INTO app.clinics (name, address_line, city, state, pincode, phone, location, created_by)
         VALUES ($1, $2, $3, $4, $5, '+91 20 1234 5678', ${POINT_SQL("$6", "$7")}, $8) RETURNING id`,
        [name, address, city, state, pincode, lng, lat, adminId],
      ));
    clinicIds.push(row!.id);
  }

  const doctorIds: string[] = [];
  for (const [name, email, spec, fee, years, clinics, status] of DOCTORS) {
    const id = await upsertUser(email, name, "DOCTOR", hash);
    doctorIds.push(id);
    await query(
      `INSERT INTO app.doctor_profiles
         (user_id, specialization_id, qualifications, registration_number, experience_years, consultation_fee,
          bio, languages, verification_status, verified_by, verified_at)
       VALUES ($1, (SELECT id FROM app.specializations WHERE name = $2), 'MBBS, MD', $3, $4, $5,
               $6, ARRAY['English', 'Hindi', 'Marathi'], $7,
               CASE WHEN $7 = 'APPROVED' THEN $8::uuid END, CASE WHEN $7 = 'APPROVED' THEN now() END)
       ON CONFLICT (user_id) DO NOTHING`,
      [id, spec, `MMC-${100000 + doctorIds.length}`, years, fee, `${name} has ${years} years of experience.`, status, adminId],
    );
    for (const ci of clinics) {
      const clinicId = clinicIds[ci]!;
      await query("INSERT INTO app.doctor_clinics VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, clinicId]);
    }
    // Mon-Sat: morning session at the first clinic, evening session at the last clinic.
    const morningClinic = clinicIds[clinics[0]!]!;
    const eveningClinic = clinicIds[clinics[clinics.length - 1]!]!;
    for (let day = 1; day <= 6; day++) {
      await query(
        `INSERT INTO app.doctor_availability (doctor_id, clinic_id, day_of_week, start_time, end_time, slot_minutes)
         VALUES ($1, $2, $3, '10:00', '13:00', 20), ($1, $4, $3, '17:00', '20:00', 20)
         ON CONFLICT DO NOTHING`,
        [id, morningClinic, day, eveningClinic],
      );
    }
  }

  for (const [name, email, lat, lng, city] of PATIENTS) {
    const id = await upsertUser(email, name, "PATIENT", hash);
    await query(
      `INSERT INTO app.patient_profiles (user_id, city, location, blood_group)
       VALUES ($1, $2, ${POINT_SQL("$3", "$4")}, 'O+') ON CONFLICT (user_id) DO NOTHING`,
      [id, city, lng, lat],
    );
  }

  // Front desk handles the two Pune doctors.
  for (const doctorId of doctorIds.slice(0, 2)) {
    await query(
      `INSERT INTO app.receptionist_assignments (receptionist_id, doctor_id, assigned_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [receptionistId, doctorId, adminId],
    );
  }

  console.log("Seed complete. Accounts (password: %s):", PASSWORD);
  console.log("  admin@demo.local, reception@demo.local");
  console.log("  doctor1..7@demo.local (doctor7 is PENDING verification)");
  console.log("  patient1..3@demo.local");
} catch (err) {
  console.error("Seed failed:", (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
