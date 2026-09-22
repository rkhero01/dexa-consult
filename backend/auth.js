// auth.js
// Self-serve signup/login for doctors and patients. Passwords hashed with
// Node's built-in scrypt (no bcrypt package needed — zero dependencies).
// A logged-in user gets a bearer token stored on their own record; requests
// to /api/me/* endpoints pass it as `Authorization: Bearer <token>`.

const crypto = require('crypto');
const db = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // timing-safe compare
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- Doctor ----------
function doctorSignup(body) {
  const { name, email, password, state, rates } = body;
  if (!name || !email || !password) {
    return { status: 400, body: { error: 'name, email and password are required' } };
  }
  if (db.doctors.where((d) => d.email === email).length) {
    return { status: 409, body: { error: 'An account with this email already exists' } };
  }
  const { salt, hash } = hashPassword(password);
  const doctor = db.doctors.insert({
    name,
    email,
    passwordSalt: salt,
    passwordHash: hash,
    state: state || 'Unassigned',
    specialization: body.specialization || 'General',
    rates: {
      chat: Number(rates?.chat) || 0,
      call: Number(rates?.call) || 0,
      video: Number(rates?.video) || 0,
    },
    status: 'offline',
    authToken: null,
  });
  return { status: 201, body: safeDoctor(doctor) };
}

function doctorLogin(body) {
  const { email, password } = body;
  const doctor = db.doctors.where((d) => d.email === email)[0];
  if (!doctor || !verifyPassword(password, doctor.passwordSalt, doctor.passwordHash)) {
    return { status: 401, body: { error: 'Invalid email or password' } };
  }
  const token = genToken();
  const updated = db.doctors.update(doctor.id, { authToken: token });
  return { status: 200, body: { token, doctor: safeDoctor(updated) } };
}

// ---------- Patient ----------
function patientSignup(body) {
  const { name, email, phone, password } = body;
  if (!name || !email || !password) {
    return { status: 400, body: { error: 'name, email and password are required' } };
  }
  if (db.patients.where((p) => p.email === email).length) {
    return { status: 409, body: { error: 'An account with this email already exists' } };
  }
  const { salt, hash } = hashPassword(password);
  const patient = db.patients.insert({
    name,
    email,
    phone: phone || '',
    passwordSalt: salt,
    passwordHash: hash,
    walletBalance: 0,
    authToken: null,
  });
  return { status: 201, body: safePatient(patient) };
}

function patientLogin(body) {
  const { email, password } = body;
  const patient = db.patients.where((p) => p.email === email)[0];
  if (!patient || !verifyPassword(password, patient.passwordSalt, patient.passwordHash)) {
    return { status: 401, body: { error: 'Invalid email or password' } };
  }
  const token = genToken();
  const updated = db.patients.update(patient.id, { authToken: token });
  return { status: 200, body: { token, patient: safePatient(updated) } };
}

// ---------- Request authentication ----------
function getBearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

function authenticateDoctor(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  return db.doctors.where((d) => d.authToken === token)[0] || null;
}

function authenticatePatient(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  return db.patients.where((p) => p.authToken === token)[0] || null;
}

// Strip sensitive fields before sending a record back to the client.
function safeDoctor(d) {
  const { passwordHash, passwordSalt, authToken, ...rest } = d;
  return rest;
}
function safePatient(p) {
  const { passwordHash, passwordSalt, authToken, ...rest } = p;
  return rest;
}

module.exports = {
  doctorSignup,
  doctorLogin,
  patientSignup,
  patientLogin,
  authenticateDoctor,
  authenticatePatient,
  safeDoctor,
  safePatient,
};
