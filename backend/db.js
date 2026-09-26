// db.js
// Hybrid persistent data layer for Dexa Consult.
// - In production (Render): Connects to PostgreSQL when DATABASE_URL is configured.
//   Tables, constraints, and indexes are auto-migrated on startup.
// - In development/testing: Falls back to robust atomic JSON file storage.
// - All route files interact with db.<collection>.find/insert/update/where/all seamlessly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pg = null;
try {
  pg = require('pg');
} catch (e) {
  // pg package will be loaded when available
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const FILES = {
  doctors: path.join(DATA_DIR, 'doctors.json'),
  patients: path.join(DATA_DIR, 'patients.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
  transactions: path.join(DATA_DIR, 'transactions.json'),
  attachments: path.join(DATA_DIR, 'attachments.json'),
};

// In-memory collection cache (provides synchronous reads and 0ms latency)
const cache = {
  doctors: [],
  patients: [],
  sessions: [],
  transactions: [],
  attachments: [],
};

let pool = null;
let isPostgresActive = false;
let initPromise = null;

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// -------------------------------------------------------------
// JSON Helpers (Atomic writes for crash safety)
// -------------------------------------------------------------
function readJsonFile(collection) {
  const file = FILES[collection];
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn(`[DB] Error parsing JSON for ${collection}, using empty array:`, err.message);
    return [];
  }
}

function writeJsonFileAtomic(collection, arr) {
  const targetFile = FILES[collection];
  const tmpFile = `${targetFile}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(arr, null, 2), 'utf-8');
    fs.renameSync(tmpFile, targetFile);
  } catch (err) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
    // Fallback direct write
    try { fs.writeFileSync(targetFile, JSON.stringify(arr, null, 2), 'utf-8'); } catch (e) {}
  }
}

// Immediately hydrate in-memory cache from JSON on require (guarantees synchronous availability)
for (const coll of Object.keys(FILES)) {
  cache[coll] = readJsonFile(coll);
}

// -------------------------------------------------------------
// PostgreSQL Schema & Query Handlers
// -------------------------------------------------------------
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

// Map JS domain record to DB row columns
function mapRecordToDb(collection, obj) {
  const d = { ...(obj || {}) };
  delete d.id;

  if (collection === 'patients') {
    const { name, email, phone, passwordSalt, passwordHash, walletBalance, authToken, resetPasswordToken, resetPasswordExpires, createdAt, updatedAt, ...rest } = d;
    return {
      id: obj.id,
      name: name || '',
      email: (email || '').toLowerCase(),
      phone: phone || '',
      password_salt: passwordSalt || '',
      password_hash: passwordHash || '',
      wallet_balance: Number(walletBalance) || 0,
      auth_token: authToken || null,
      reset_password_token: resetPasswordToken || null,
      reset_password_expires: resetPasswordExpires ? new Date(resetPasswordExpires) : null,
      created_at: createdAt ? new Date(createdAt) : new Date(),
      updated_at: updatedAt ? new Date(updatedAt) : new Date(),
      data: rest,
    };
  }

  if (collection === 'doctors') {
    const { name, email, phone, passwordSalt, passwordHash, walletBalance, specialization, state, rates, status, authToken, resetPasswordToken, resetPasswordExpires, createdAt, updatedAt, ...rest } = d;
    return {
      id: obj.id,
      name: name || '',
      email: (email || '').toLowerCase(),
      phone: phone || '',
      password_salt: passwordSalt || '',
      password_hash: passwordHash || '',
      wallet_balance: Number(walletBalance) || 0,
      specialization: specialization || 'General',
      state: state || 'Unassigned',
      rates: rates || { chat: 0, call: 0, video: 0 },
      status: status || 'offline',
      auth_token: authToken || null,
      reset_password_token: resetPasswordToken || null,
      reset_password_expires: resetPasswordExpires ? new Date(resetPasswordExpires) : null,
      created_at: createdAt ? new Date(createdAt) : new Date(),
      updated_at: updatedAt ? new Date(updatedAt) : new Date(),
      data: rest,
    };
  }

  if (collection === 'sessions') {
    const { patientId, doctorId, type, status, ratePerMin, elapsedSec, amountCharged, requestedAt, acceptedAt, billingStartTime, startTime, endedAt, endedReason, channelName, messages, createdAt, updatedAt, ...rest } = d;
    return {
      id: obj.id,
      patient_id: patientId || null,
      doctor_id: doctorId || null,
      type: type || 'chat',
      status: status || 'pending',
      rate_per_min: Number(ratePerMin) || 0,
      elapsed_sec: Number(elapsedSec) || 0,
      amount_charged: Number(amountCharged) || 0,
      requested_at: requestedAt ? new Date(requestedAt) : null,
      accepted_at: acceptedAt ? new Date(acceptedAt) : null,
      billing_start_time: billingStartTime ? new Date(billingStartTime) : null,
      start_time: startTime ? new Date(startTime) : null,
      ended_at: endedAt ? new Date(endedAt) : null,
      ended_reason: endedReason || null,
      channel_name: channelName || null,
      messages: Array.isArray(messages) ? JSON.stringify(messages) : '[]',
      created_at: createdAt ? new Date(createdAt) : new Date(),
      updated_at: updatedAt ? new Date(updatedAt) : new Date(),
      data: rest,
    };
  }

  if (collection === 'attachments') {
    const { sessionId, uploaderId, uploaderRole, storedFileName, originalName, type, mimeType, size, url, createdAt, updatedAt, ...rest } = d;
    return {
      id: obj.id,
      session_id: sessionId || null,
      uploader_id: uploaderId || null,
      uploader_role: uploaderRole || null,
      stored_file_name: storedFileName || '',
      original_name: originalName || '',
      type: type || 'file',
      mime_type: mimeType || 'application/octet-stream',
      size: Number(size) || 0,
      url: url || '',
      created_at: createdAt ? new Date(createdAt) : new Date(),
      updated_at: updatedAt ? new Date(updatedAt) : new Date(),
      data: rest,
    };
  }

  if (collection === 'transactions') {
    const { patientId, type, amount, note, createdAt, ...rest } = d;
    return {
      id: obj.id,
      patient_id: patientId || null,
      type: type || 'recharge',
      amount: Number(amount) || 0,
      note: note || '',
      created_at: createdAt ? new Date(createdAt) : new Date(),
      data: rest,
    };
  }

  return { id: obj.id, data: d };
}

// Map PostgreSQL row back to JS object
function mapDbToRecord(collection, row) {
  if (!row) return null;
  const extra = row.data && typeof row.data === 'object' ? row.data : {};

  if (collection === 'patients') {
    return {
      ...extra,
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone || '',
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      walletBalance: Number(row.wallet_balance) || 0,
      authToken: row.auth_token || null,
      resetPasswordToken: row.reset_password_token || null,
      resetPasswordExpires: row.reset_password_expires ? new Date(row.reset_password_expires).toISOString() : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  if (collection === 'doctors') {
    return {
      ...extra,
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone || '',
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      walletBalance: Number(row.wallet_balance) || 0,
      specialization: row.specialization || 'General',
      state: row.state || 'Unassigned',
      rates: row.rates || { chat: 0, call: 0, video: 0 },
      status: row.status || 'offline',
      authToken: row.auth_token || null,
      resetPasswordToken: row.reset_password_token || null,
      resetPasswordExpires: row.reset_password_expires ? new Date(row.reset_password_expires).toISOString() : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  if (collection === 'sessions') {
    return {
      ...extra,
      id: row.id,
      patientId: row.patient_id,
      doctorId: row.doctor_id,
      type: row.type,
      status: row.status,
      ratePerMin: Number(row.rate_per_min) || 0,
      elapsedSec: Number(row.elapsed_sec) || 0,
      amountCharged: Number(row.amount_charged) || 0,
      requestedAt: row.requested_at ? new Date(row.requested_at).toISOString() : null,
      acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
      billingStartTime: row.billing_start_time ? new Date(row.billing_start_time).toISOString() : null,
      startTime: row.start_time ? new Date(row.start_time).toISOString() : null,
      endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
      endedReason: row.ended_reason || null,
      channelName: row.channel_name || null,
      messages: typeof row.messages === 'string' ? JSON.parse(row.messages) : (row.messages || []),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  if (collection === 'attachments') {
    return {
      ...extra,
      id: row.id,
      sessionId: row.session_id,
      uploaderId: row.uploader_id,
      uploaderRole: row.uploader_role,
      storedFileName: row.stored_file_name,
      originalName: row.original_name,
      type: row.type,
      mimeType: row.mime_type,
      size: Number(row.size) || 0,
      url: row.url,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  if (collection === 'transactions') {
    return {
      ...extra,
      id: row.id,
      patientId: row.patient_id,
      type: row.type,
      amount: Number(row.amount) || 0,
      note: row.note || '',
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    };
  }

  return { id: row.id, ...extra };
}

// Asynchronously upsert record to PostgreSQL
async function persistUpsertPostgres(collection, record) {
  if (!isPostgresActive || !pool) return;
  try {
    const dbRow = mapRecordToDb(collection, record);
    const keys = Object.keys(dbRow);
    const cols = keys.join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const updateClauses = keys
      .filter((k) => k !== 'id' && k !== 'created_at')
      .map((k) => `${k} = EXCLUDED.${k}`)
      .join(', ');

    const sql = `
      INSERT INTO ${collection} (${cols})
      VALUES (${placeholders})
      ON CONFLICT (id) DO UPDATE SET ${updateClauses};
    `;

    const values = keys.map((k) => {
      const val = dbRow[k];
      if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
        return JSON.stringify(val);
      }
      return val;
    });

    await pool.query(sql, values);
  } catch (err) {
    console.error(`[DB Postgres Error] Failed to persist ${collection} (${record.id}):`, err.message);
  }
}

// -------------------------------------------------------------
// Database Initialization (PostgreSQL or JSON fallback)
// -------------------------------------------------------------
async function init(customDbUrl = null) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const dbUrl = customDbUrl || process.env.DATABASE_URL;

    if (!dbUrl) {
      if (process.env.NODE_ENV === 'production') {
        console.warn('========================================================================');
        console.warn('[DB WARNING] DATABASE_URL is not set in production!');
        console.warn('Render free tier has an ephemeral disk. To ensure account and password');
        console.warn('changes persist across restarts, set DATABASE_URL in Render Environment.');
        console.warn('Falling back to local JSON file storage.');
        console.warn('========================================================================');
      } else {
        console.log('[DB] Using local JSON storage fallback (no DATABASE_URL provided).');
      }
      return false;
    }

    if (!pg) {
      console.error('[DB] PostgreSQL driver "pg" could not be loaded. Falling back to JSON storage.');
      return false;
    }

    try {
      const ssl = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false };

      pool = new pg.Pool({
        connectionString: dbUrl,
        ssl,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      // Verify connection
      const client = await pool.connect();
      client.release();

      // Create tables & indexes
      await pool.query(TABLE_DEFINITIONS);
      isPostgresActive = true;
      console.log('[DB] Successfully connected to PostgreSQL. Tables verified.');

      // Hydrate in-memory cache from PostgreSQL
      for (const coll of Object.keys(FILES)) {
        const res = await pool.query(`SELECT * FROM ${coll}`);
        if (res.rows.length > 0) {
          cache[coll] = res.rows.map((row) => mapDbToRecord(coll, row));
          // Keep local backup file updated
          writeJsonFileAtomic(coll, cache[coll]);
          console.log(`[DB] Hydrated ${cache[coll].length} ${coll} from PostgreSQL.`);
        } else {
          // Table in Postgres is empty - auto-seed from local JSON files
          const seedRecords = readJsonFile(coll);
          if (seedRecords && seedRecords.length > 0) {
            console.log(`[DB] Auto-seeding ${seedRecords.length} ${coll} from JSON into PostgreSQL...`);
            for (const rec of seedRecords) {
              await persistUpsertPostgres(coll, rec);
            }
            cache[coll] = seedRecords;
          }
        }
      }

      return true;
    } catch (err) {
      console.error('[DB ERROR] Failed to connect to PostgreSQL:', err.message);
      console.warn('[DB] Falling back to local JSON file storage.');
      isPostgresActive = false;
      return false;
    }
  })();

  return initPromise;
}

// -------------------------------------------------------------
// Collection API (Identical synchronous interface for callers)
// -------------------------------------------------------------
function makeCollection(name) {
  return {
    all() {
      return [...(cache[name] || [])];
    },
    find(id_) {
      return (cache[name] || []).find((x) => x.id === id_) || null;
    },
    where(predicate) {
      return (cache[name] || []).filter(predicate);
    },
    insert(obj) {
      const record = {
        id: obj.id || genId(),
        createdAt: obj.createdAt || new Date().toISOString(),
        ...obj,
      };
      cache[name].push(record);

      // Write to JSON backup
      writeJsonFileAtomic(name, cache[name]);

      // Write to PostgreSQL if active
      if (isPostgresActive) {
        persistUpsertPostgres(name, record);
      }

      return record;
    },
    update(id_, patch) {
      const arr = cache[name];
      const idx = arr.findIndex((x) => x.id === id_);
      if (idx === -1) return null;

      arr[idx] = { ...arr[idx], ...patch, updatedAt: new Date().toISOString() };

      // Write to JSON backup
      writeJsonFileAtomic(name, arr);

      // Write to PostgreSQL if active
      if (isPostgresActive) {
        persistUpsertPostgres(name, arr[idx]);
      }

      return arr[idx];
    },
    remove(id_) {
      const arr = cache[name];
      const idx = arr.findIndex((x) => x.id === id_);
      if (idx === -1) return false;
      arr.splice(idx, 1);
      writeJsonFileAtomic(name, arr);
      if (isPostgresActive && pool) {
        pool.query(`DELETE FROM ${name} WHERE id = $1`, [id_]).catch((e) => {
          console.error(`[DB] Failed to delete from ${name}:`, e.message);
        });
      }
      return true;
    },
  };
}

module.exports = {
  doctors: makeCollection('doctors'),
  patients: makeCollection('patients'),
  sessions: makeCollection('sessions'),
  transactions: makeCollection('transactions'),
  attachments: makeCollection('attachments'),
  genId,
  init,
  get isPostgres() {
    return isPostgresActive;
  },
  get pool() {
    return pool;
  },
};
