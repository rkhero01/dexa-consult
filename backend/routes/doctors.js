const db = require('../db');
const billingEngine = require('../billingEngine');
const auth = require('../auth');

module.exports = {
  // POST /api/doctors  { name, specialization, state, rates: {chat, call, video} }
  // NOTE: this admin-style create has no login (no email/password) — prefer
  // /api/auth/doctor/signup so the doctor can log into their own dashboard.
  create(body) {
    if (!body.name || !body.rates) {
      return { status: 400, body: { error: 'name and rates are required' } };
    }
    const doctor = db.doctors.insert({
      name: body.name,
      specialization: body.specialization || 'General',
      state: body.state || 'Unassigned',
      rates: {
        chat: Number(body.rates.chat) || 0,
        call: Number(body.rates.call) || 0,
        video: Number(body.rates.video) || 0,
      },
      status: 'offline', // offline | online | busy
    });
    return { status: 201, body: auth.safeDoctor(doctor) };
  },

  // GET /api/doctors?state=Gujarat&online=true
  list(query) {
    let doctors = db.doctors.all();
    if (query.state) doctors = doctors.filter((d) => d.state === query.state);
    if (query.online === 'true') doctors = doctors.filter((d) => d.status === 'online');
    return { status: 200, body: doctors.map(auth.safeDoctor) };
  },

  get(id) {
    const doctor = db.doctors.find(id);
    if (!doctor) return { status: 404, body: { error: 'Doctor not found' } };
    return { status: 200, body: auth.safeDoctor(doctor) };
  },

  // PATCH /api/doctors/:id  { rates?, status?, state?, specialization? }
  update(id, body) {
    const doctor = db.doctors.find(id);
    if (!doctor) return { status: 404, body: { error: 'Doctor not found' } };
    const patch = {};
    if (body.rates) patch.rates = { ...doctor.rates, ...body.rates };
    if (body.status) patch.status = body.status;
    if (body.state) patch.state = body.state;
    if (body.specialization) patch.specialization = body.specialization;
    const updated = db.doctors.update(id, patch);
    return { status: 200, body: auth.safeDoctor(updated) };
  },

  // GET /api/doctors/:id/earnings
  earnings(id) {
    const doctor = db.doctors.find(id);
    if (!doctor) return { status: 404, body: { error: 'Doctor not found' } };
    return { status: 200, body: billingEngine.doctorEarnings(id) };
  },
};
