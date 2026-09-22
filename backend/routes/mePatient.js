const db = require('../db');
const auth = require('../auth');
const sessionsCtrl = require('./sessions');

function requirePatient(req) {
  const patient = auth.authenticatePatient(req);
  if (!patient) return null;
  return patient;
}

module.exports = {
  // GET /api/me/patient  — profile + current active session (if any)
  profile(req) {
    const patient = requirePatient(req);
    if (!patient) return { status: 401, body: { error: 'Login required' } };
    const activeSession = db.sessions.where(
      (s) => s.patientId === patient.id && s.status === 'active'
    )[0] || null;
    return { status: 200, body: { ...auth.safePatient(patient), activeSession } };
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
