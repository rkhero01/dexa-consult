const db = require('../db');
const auth = require('../auth');

module.exports = {
  // POST /api/patients  { name, phone }
  createPatient(body) {
    if (!body.name || !body.phone) {
      return { status: 400, body: { error: 'name and phone are required' } };
    }
    const existing = db.patients.where((p) => p.phone === body.phone)[0];
    if (existing) return { status: 200, body: auth.safePatient(existing) };
    const patient = db.patients.insert({
      name: body.name,
      phone: body.phone,
      walletBalance: 0,
    });
    return { status: 201, body: auth.safePatient(patient) };
  },

  // POST /api/wallet/recharge  { patientId, amount, paymentRef }
  recharge(body) {
    const patient = db.patients.find(body.patientId);
    if (!patient) return { status: 404, body: { error: 'Patient not found' } };
    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return { status: 400, body: { error: 'amount must be a positive number' } };
    }
    // NOTE: in production, verify body.paymentRef against Razorpay/PhonePe
    // webhook before crediting the wallet. This prototype credits directly.
    const newBalance = +(patient.walletBalance + amount).toFixed(2);
    db.patients.update(patient.id, { walletBalance: newBalance });
    db.transactions.insert({
      patientId: patient.id,
      type: 'recharge',
      amount,
      note: body.paymentRef ? `Recharge ref:${body.paymentRef}` : 'Recharge',
    });
    return { status: 200, body: { patientId: patient.id, walletBalance: newBalance } };
  },

  // GET /api/wallet/:patientId
  balance(patientId) {
    const patient = db.patients.find(patientId);
    if (!patient) return { status: 404, body: { error: 'Patient not found' } };
    return { status: 200, body: { patientId, walletBalance: patient.walletBalance } };
  },

  // GET /api/wallet/:patientId/transactions
  transactions(patientId) {
    const patient = db.patients.find(patientId);
    if (!patient) return { status: 404, body: { error: 'Patient not found' } };
    const txns = db.transactions.where((t) => t.patientId === patientId).reverse();
    return { status: 200, body: txns };
  },
};
