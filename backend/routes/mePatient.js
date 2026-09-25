const db = require('../db');
const auth = require('../auth');
const sessionsCtrl = require('./sessions');

function requirePatient(req) {
  const patient = auth.authenticatePatient(req);
  if (!patient) return null;
  return patient;
}

module.exports = {
  // GET /api/me/patient  — profile + current active / pending session (if any)
  profile(req) {
    const patient = requirePatient(req);
    if (!patient) return { status: 401, body: { error: 'Login required' } };
    const activeSession = db.sessions.where(
      (s) => s.patientId === patient.id && (s.status === 'active' || s.status === 'pending')
    )[0] || null;
    return { status: 200, body: { ...auth.safePatient(patient), activeSession } };
  },

  // PATCH /api/me/patient  { name?, email?, phone? }
  update(req, body) {
    const patient = requirePatient(req);
    if (!patient) return { status: 401, body: { error: 'Login required' } };

    const { name, email, phone } = body || {};
    const patch = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return { status: 400, body: { error: 'Name cannot be empty' } };
      }
      patch.name = name.trim();
    }

    if (email !== undefined) {
      const trimmedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
        return { status: 400, body: { error: 'A valid email is required' } };
      }
      const existing = db.patients.where(
        (p) => p.email && p.email.toLowerCase() === trimmedEmail && p.id !== patient.id
      );
      if (existing.length > 0) {
        return { status: 409, body: { error: 'An account with this email already exists' } };
      }
      patch.email = trimmedEmail;
    }

    if (phone !== undefined) {
      patch.phone = typeof phone === 'string' ? phone.trim() : String(phone);
    }

    if (Object.keys(patch).length === 0) {
      return { status: 400, body: { error: 'At least one field (name, email, phone) is required to update' } };
    }

    const updated = db.patients.update(patient.id, patch);
    return { status: 200, body: auth.safePatient(updated) };
  },

  // GET /api/me/patient/doctors  — browse doctors available to book
  browseDoctors(req) {
    const patient = requirePatient(req);
    if (!patient) return { status: 401, body: { error: 'Login required' } };
    return { status: 200, body: db.doctors.all().map(auth.safeDoctor) };
  },

  // POST /api/me/patient/recharge  { amount, paymentRef }
  recharge(req, body) {
    const patient = requirePatient(req);
    if (!patient) return { status: 401, body: { error: 'Login required' } };
    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return { status: 400, body: { error: 'amount must be a positive number' } };
    }
    const newBalance = +(patient.walletBalance + amount).toFixed(2);
    db.patients.update(patient.id, { walletBalance: newBalance });
    db.transactions.insert({
      patientId: patient.id,
      type: 'recharge',
      amount,
      note: body.paymentRef ? `Recharge ref:${body.paymentRef}` : 'Recharge',
    });
    return { status: 200, body: { walletBalance: newBalance } };
  },

  // POST /api/me/patient/book  { doctorId, type }
  book(req, body) {
    const patient = requirePatient(req);
    if (!patient) return { status: 401, body: { error: 'Login required' } };
    return sessionsCtrl.start({ patientId: patient.id, doctorId: body.doctorId, type: body.type });
  },

  // GET /api/me/patient/sessions  — consultation history
  sessions(req) {
    const patient = requirePatient(req);
    if (!patient) return { status: 401, body: { error: 'Login required' } };
    const sessions = db.sessions.where((s) => s.patientId === patient.id).reverse();
    return { status: 200, body: sessions };
  },
};
