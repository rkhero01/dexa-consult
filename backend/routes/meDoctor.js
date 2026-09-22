const db = require('../db');
const auth = require('../auth');
const billingEngine = require('../billingEngine');

function requireDoctor(req) {
  const doctor = auth.authenticateDoctor(req);
  if (!doctor) return null;
  return doctor;
}

module.exports = {
  // GET /api/me/doctor  — profile + current active session (if any)
  profile(req) {
    const doctor = requireDoctor(req);
    if (!doctor) return { status: 401, body: { error: 'Login required' } };
    const activeSession = db.sessions.where(
      (s) => s.doctorId === doctor.id && s.status === 'active'
    )[0] || null;
    return { status: 200, body: { ...auth.safeDoctor(doctor), activeSession } };
  },

  // PATCH /api/me/doctor  { rates?, status?, state? }
  update(req, body) {
    const doctor = requireDoctor(req);
    if (!doctor) return { status: 401, body: { error: 'Login required' } };
    const patch = {};
    if (body.rates) patch.rates = { ...doctor.rates, ...body.rates };
    if (body.status) patch.status = body.status;
    if (body.state) patch.state = body.state;
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
