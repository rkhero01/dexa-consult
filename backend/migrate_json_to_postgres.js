// migrate_json_to_postgres.js
// Safe, idempotent migration script to seed or migrate local JSON data into PostgreSQL.
//
// Usage:
//   node backend/migrate_json_to_postgres.js
//   OR
//   node backend/migrate_json_to_postgres.js "postgresql://user:pass@host/dbname"

const path = require('path');
const fs = require('fs');

let pg;
try {
  pg = require('pg');
} catch (e) {
  console.error('Error: "pg" module not installed. Please run "npm install pg" in the backend directory.');
  process.exit(1);
}

const dbUrl = process.argv[2] || process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('========================================================================');
  console.error('Error: DATABASE_URL is not set and was not provided as an argument.');
  console.error('Usage:');
  console.error('  DATABASE_URL="postgres://..." node backend/migrate_json_to_postgres.js');
  console.error('  OR');
  console.error('  node backend/migrate_json_to_postgres.js "postgres://..."');
  console.error('========================================================================');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  patients: path.join(DATA_DIR, 'patients.json'),
  doctors: path.join(DATA_DIR, 'doctors.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
  attachments: path.join(DATA_DIR, 'attachments.json'),
  transactions: path.join(DATA_DIR, 'transactions.json'),
};

const TABLE_DEFINITIONS = `
CREATE TABLE IF NOT EXISTS patients (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50) DEFAULT '',
  password_salt VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  wallet_balance NUMERIC(12, 2) DEFAULT 0,
  auth_token VARCHAR(255),
  reset_password_token VARCHAR(255),
  reset_password_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(email);
CREATE INDEX IF NOT EXISTS idx_patients_auth_token ON patients(auth_token);

CREATE TABLE IF NOT EXISTS doctors (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50) DEFAULT '',
  password_salt VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  wallet_balance NUMERIC(12, 2) DEFAULT 0,
  specialization VARCHAR(255) DEFAULT 'General',
  state VARCHAR(255) DEFAULT 'Unassigned',
  rates JSONB DEFAULT '{"chat":0,"call":0,"video":0}',
  status VARCHAR(50) DEFAULT 'offline',
  auth_token VARCHAR(255),
  reset_password_token VARCHAR(255),
  reset_password_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_doctors_email ON doctors(email);
CREATE INDEX IF NOT EXISTS idx_doctors_auth_token ON doctors(auth_token);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  patient_id VARCHAR(64),
  doctor_id VARCHAR(64),
  type VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  rate_per_min NUMERIC(10, 2) DEFAULT 0,
  elapsed_sec INT DEFAULT 0,
  amount_charged NUMERIC(12, 2) DEFAULT 0,
  requested_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  billing_start_time TIMESTAMPTZ,
  start_time TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ended_reason VARCHAR(100),
  channel_name VARCHAR(255),
  messages JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_patient_id ON sessions(patient_id);
CREATE INDEX IF NOT EXISTS idx_sessions_doctor_id ON sessions(doctor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS attachments (
  id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64),
  uploader_id VARCHAR(64),
  uploader_role VARCHAR(50),
  stored_file_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size BIGINT DEFAULT 0,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_attachments_session_id ON attachments(session_id);

CREATE TABLE IF NOT EXISTS transactions (
  id VARCHAR(64) PRIMARY KEY,
  patient_id VARCHAR(64),
  type VARCHAR(50),
  amount NUMERIC(12, 2) DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_transactions_patient_id ON transactions(patient_id);
`;

function readJson(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

async function migrate() {
  const ssl = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false };

  const pool = new pg.Pool({ connectionString: dbUrl, ssl });

  console.log('--- Starting Dexa Consult JSON to PostgreSQL Migration ---');
  console.log(`Target: ${dbUrl.replace(/:[^:@]+@/, ':****@')}`);

  try {
    const client = await pool.connect();
    client.release();
    console.log('✓ Successfully connected to PostgreSQL database.');

    // 1. Ensure schema
    await pool.query(TABLE_DEFINITIONS);
    console.log('✓ Verified table schemas and indexes.');

    // 2. Migrate Patients
    const patients = readJson(FILES.patients);
    let pInserted = 0;
    let pUpdated = 0;
    for (const p of patients) {
      if (!p.id || !p.email) continue;
      const res = await pool.query(
        `INSERT INTO patients (id, name, email, phone, password_salt, password_hash, wallet_balance, auth_token, reset_password_token, reset_password_expires, created_at, updated_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           password_salt = EXCLUDED.password_salt,
           password_hash = EXCLUDED.password_hash,
           wallet_balance = EXCLUDED.wallet_balance,
           auth_token = EXCLUDED.auth_token,
           updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS is_new;`,
        [
          p.id,
          p.name || 'Patient',
          (p.email || '').toLowerCase().trim(),
          p.phone || '',
          p.passwordSalt || '',
          p.passwordHash || '',
          Number(p.walletBalance) || 0,
          p.authToken || null,
          p.resetPasswordToken || null,
          p.resetPasswordExpires ? new Date(p.resetPasswordExpires) : null,
          p.createdAt ? new Date(p.createdAt) : new Date(),
          p.updatedAt ? new Date(p.updatedAt) : new Date(),
          JSON.stringify({}),
        ]
      );
      if (res.rows[0]?.is_new) pInserted++;
      else pUpdated++;
    }
    console.log(`✓ Patients migrated: ${patients.length} total (${pInserted} new, ${pUpdated} updated/preserved).`);

    // 3. Migrate Doctors
    const doctors = readJson(FILES.doctors);
    let dInserted = 0;
    let dUpdated = 0;
    for (const d of doctors) {
      if (!d.id || !d.email) continue;
      const res = await pool.query(
        `INSERT INTO doctors (id, name, email, phone, password_salt, password_hash, wallet_balance, specialization, state, rates, status, auth_token, reset_password_token, reset_password_expires, created_at, updated_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           password_salt = EXCLUDED.password_salt,
           password_hash = EXCLUDED.password_hash,
           wallet_balance = EXCLUDED.wallet_balance,
           specialization = EXCLUDED.specialization,
           state = EXCLUDED.state,
           rates = EXCLUDED.rates,
           status = EXCLUDED.status,
           auth_token = EXCLUDED.auth_token,
           updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS is_new;`,
        [
          d.id,
          d.name || 'Doctor',
          (d.email || '').toLowerCase().trim(),
          d.phone || '',
          d.passwordSalt || '',
          d.passwordHash || '',
          Number(d.walletBalance) || 0,
          d.specialization || 'General',
          d.state || 'Unassigned',
          JSON.stringify(d.rates || { chat: 0, call: 0, video: 0 }),
          d.status || 'offline',
          d.authToken || null,
          d.resetPasswordToken || null,
          d.resetPasswordExpires ? new Date(d.resetPasswordExpires) : null,
          d.createdAt ? new Date(d.createdAt) : new Date(),
          d.updatedAt ? new Date(d.updatedAt) : new Date(),
          JSON.stringify({}),
        ]
      );
      if (res.rows[0]?.is_new) dInserted++;
      else dUpdated++;
    }
    console.log(`✓ Doctors migrated: ${doctors.length} total (${dInserted} new, ${dUpdated} updated/preserved).`);

    // 4. Migrate Sessions
    const sessions = readJson(FILES.sessions);
    let sInserted = 0;
    for (const s of sessions) {
      if (!s.id) continue;
      await pool.query(
        `INSERT INTO sessions (id, patient_id, doctor_id, type, status, rate_per_min, elapsed_sec, amount_charged, requested_at, accepted_at, billing_start_time, start_time, ended_at, ended_reason, channel_name, messages, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (id) DO NOTHING;`,
        [
          s.id,
          s.patientId || null,
          s.doctorId || null,
          s.type || 'chat',
          s.status || 'pending',
          Number(s.ratePerMin) || 0,
          Number(s.elapsedSec) || 0,
          Number(s.amountCharged) || 0,
          s.requestedAt ? new Date(s.requestedAt) : null,
          s.acceptedAt ? new Date(s.acceptedAt) : null,
          s.billingStartTime ? new Date(s.billingStartTime) : null,
          s.startTime ? new Date(s.startTime) : null,
          s.endedAt ? new Date(s.endedAt) : null,
          s.endedReason || null,
          s.channelName || null,
          JSON.stringify(s.messages || []),
          s.createdAt ? new Date(s.createdAt) : new Date(),
          s.updatedAt ? new Date(s.updatedAt) : new Date(),
        ]
      );
      sInserted++;
    }
    console.log(`✓ Sessions processed: ${sInserted}.`);

    // 5. Migrate Attachments
    const attachments = readJson(FILES.attachments);
    let aInserted = 0;
    for (const a of attachments) {
      if (!a.id) continue;
      await pool.query(
        `INSERT INTO attachments (id, session_id, uploader_id, uploader_role, stored_file_name, original_name, type, mime_type, size, url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING;`,
        [
          a.id,
          a.sessionId || null,
          a.uploaderId || null,
          a.uploaderRole || null,
          a.storedFileName || '',
          a.originalName || '',
          a.type || 'file',
          a.mimeType || 'application/octet-stream',
          Number(a.size) || 0,
          a.url || '',
          a.createdAt ? new Date(a.createdAt) : new Date(),
          a.updatedAt ? new Date(a.updatedAt) : new Date(),
        ]
      );
      aInserted++;
    }
    console.log(`✓ Attachments processed: ${aInserted}.`);

    // 6. Migrate Transactions
    const txns = readJson(FILES.transactions);
    let tInserted = 0;
    for (const t of txns) {
      if (!t.id) continue;
      await pool.query(
        `INSERT INTO transactions (id, patient_id, type, amount, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING;`,
        [
          t.id,
          t.patientId || null,
          t.type || 'recharge',
          Number(t.amount) || 0,
          t.note || '',
          t.createdAt ? new Date(t.createdAt) : new Date(),
        ]
      );
      tInserted++;
    }
    console.log(`✓ Transactions processed: ${tInserted}.`);

    console.log('====================================================');
    console.log('🎉 PostgreSQL Migration Completed Successfully!');
    console.log('All existing account IDs, password hashes, and salts are preserved.');
    console.log('====================================================');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
