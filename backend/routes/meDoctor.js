const db = require('../db');
const auth = require('../auth');
const billingEngine = require('../billingEngine');

function requireDoctor(req) {
  const doctor = auth.authenticateDoctor(req);
  if (!doctor) return null;
  return doctor;
}

module.exports = {
  // GET /api/me/doctor  — profile + current active / pending session (if any)
  profile(req) {
    const doctor = requireDoctor(req);
    if (!doctor) return { status: 401, body: { error: 'Login required' } };
    const activeSession = db.sessions.where(
      (s) => s.doctorId === doctor.id && s.status === 'active'
    )[0] || null;
    const pendingSession = db.sessions.where(
      (s) => s.doctorId === doctor.id && s.status === 'pending'
    )[0] || null;
    return { status: 200, body: { ...auth.safeDoctor(doctor), activeSession, pendingSession } };
  },

  // PATCH /api/me/doctor  { rates?, status?, state?, name?, email?, specialization? }
  update(req, body) {
    const doctor = requireDoctor(req);
    if (!doctor) return { status: 401, body: { error: 'Login required' } };
    const patch = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return { status: 400, body: { error: 'Name cannot be empty' } };
      }
      patch.name = body.name.trim();
    }

    if (body.email !== undefined) {
      const trimmedEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
        return { status: 400, body: { error: 'A valid email is required' } };
      }
      const existing = db.doctors.where(
        (d) => d.email && d.email.toLowerCase() === trimmedEmail && d.id !== doctor.id
      );
      if (existing.length > 0) {
        return { status: 409, body: { error: 'An account with this email already exists' } };
      }
      patch.email = trimmedEmail;
    }

    if (body.specialization !== undefined) patch.specialization = String(body.specialization).trim();
    if (body.rates) patch.rates = { ...doctor.rates, ...body.rates };
    if (body.status !== undefined) patch.status = body.status;
    if (body.state !== undefined) patch.state = body.state;

    if (Object.keys(patch).length === 0) {
      return { status: 400, body: { error: 'No fields provided to update' } };
    }

    const updated = db.doctors.update(doctor.id, patch);
    return { status: 200, body: auth.safeDoctor(updated) };
  },

  // GET /api/me/doctor/earnings
  earnings(req) {
    const doctor = requireDoctor(req);
    if (!doctor) return { status: 401, body: { error: 'Login required' } };
    return { status: 200, body: billingEngine.doctorEarnings(doctor.id) };
  },

  // GET /api/me/doctor/sessions  — consultation history
  sessions(req) {
    const doctor = requireDoctor(req);
    if (!doctor) return { status: 401, body: { error: 'Login required' } };
    const sessions = db.sessions.where((s) => s.doctorId === doctor.id).reverse();
    return { status: 200, body: sessions };
  },
};
