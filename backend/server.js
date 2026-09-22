// server.js
// Entry point. Pure Node `http` module — no Express needed, so this runs
// with zero `npm install`. CORS is wide open here so your separate website
// (different domain) can call these APIs directly from the browser; lock
// `Access-Control-Allow-Origin` down to your real domain before going live.

const http = require('http');
const { URL } = require('url');

const doctorsCtrl = require('./routes/doctors');
const walletCtrl = require('./routes/wallet');
const sessionsCtrl = require('./routes/sessions');
const authCtrl = require('./auth');
const meDoctorCtrl = require('./routes/meDoctor');
const mePatientCtrl = require('./routes/mePatient');

const PORT = process.env.PORT || 4000;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

// Runs a controller call and sends its {status, body} result in one shot.
function reply(res, result) {
  send(res, result.status, result.body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','sessions','abc123','end']

  try {
    // --- SSE stream (must not be JSON-wrapped) ---
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'events' && req.method === 'GET') {
      return sessionsCtrl.events(parts[2], res);
    }

    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams);

    // --- Auth (self-serve signup / login) ---
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'doctor' && parts[3] === 'signup' && req.method === 'POST') {
      return reply(res, authCtrl.doctorSignup(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'doctor' && parts[3] === 'login' && req.method === 'POST') {
      return reply(res, authCtrl.doctorLogin(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'patient' && parts[3] === 'signup' && req.method === 'POST') {
      return reply(res, authCtrl.patientSignup(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'patient' && parts[3] === 'login' && req.method === 'POST') {
      return reply(res, authCtrl.patientLogin(body));
    }

    // --- Doctor's own dashboard (requires Authorization: Bearer <token>) ---
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'doctor' && parts.length === 3) {
      if (req.method === 'GET') return reply(res, meDoctorCtrl.profile(req));
      if (req.method === 'PATCH') return reply(res, meDoctorCtrl.update(req, body));
    }
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'doctor' && parts[3] === 'earnings' && req.method === 'GET') {
      return reply(res, meDoctorCtrl.earnings(req));
    }
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'doctor' && parts[3] === 'sessions' && req.method === 'GET') {
      return reply(res, meDoctorCtrl.sessions(req));
    }

    // --- Patient's own dashboard (requires Authorization: Bearer <token>) ---
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'patient' && parts.length === 3 && req.method === 'GET') {
      return reply(res, mePatientCtrl.profile(req));
    }
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'patient' && parts[3] === 'doctors' && req.method === 'GET') {
      return reply(res, mePatientCtrl.browseDoctors(req));
    }
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'patient' && parts[3] === 'recharge' && req.method === 'POST') {
      return reply(res, mePatientCtrl.recharge(req, body));
    }
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'patient' && parts[3] === 'book' && req.method === 'POST') {
      return reply(res, mePatientCtrl.book(req, body));
    }
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'patient' && parts[3] === 'sessions' && req.method === 'GET') {
      return reply(res, mePatientCtrl.sessions(req));
    }

    // --- Doctors (admin/public listing — unchanged) ---
    if (parts[0] === 'api' && parts[1] === 'doctors' && parts.length === 2) {
      if (req.method === 'POST') return reply(res, doctorsCtrl.create(body));
      if (req.method === 'GET') return reply(res, doctorsCtrl.list(query));
    }
    if (parts[0] === 'api' && parts[1] === 'doctors' && parts[3] === 'earnings' && req.method === 'GET') {
      return reply(res, doctorsCtrl.earnings(parts[2]));
    }
    if (parts[0] === 'api' && parts[1] === 'doctors' && parts.length === 3) {
      if (req.method === 'GET') return reply(res, doctorsCtrl.get(parts[2]));
      if (req.method === 'PATCH') return reply(res, doctorsCtrl.update(parts[2], body));
    }

    // --- Patients / Wallet ---
    if (parts[0] === 'api' && parts[1] === 'patients' && req.method === 'POST') {
      return reply(res, walletCtrl.createPatient(body));
    }
    if (parts[0] === 'api' && parts[1] === 'wallet' && parts[2] === 'recharge' && req.method === 'POST') {
      return reply(res, walletCtrl.recharge(body));
    }
    if (parts[0] === 'api' && parts[1] === 'wallet' && parts[3] === 'transactions' && req.method === 'GET') {
      return reply(res, walletCtrl.transactions(parts[2]));
    }
    if (parts[0] === 'api' && parts[1] === 'wallet' && parts.length === 3 && req.method === 'GET') {
      return reply(res, walletCtrl.balance(parts[2]));
    }

    // --- Sessions ---
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2] === 'start' && req.method === 'POST') {
      return reply(res, sessionsCtrl.start(body));
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'end' && req.method === 'POST') {
      return reply(res, sessionsCtrl.end(parts[2]));
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'chat' && req.method === 'POST') {
      return reply(res, sessionsCtrl.chat(parts[2], body));
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'signal' && req.method === 'POST') {
      return reply(res, sessionsCtrl.signal(parts[2], body));
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3 && req.method === 'GET') {
      return reply(res, sessionsCtrl.get(parts[2]));
    }

    // health check
    if (parts.length === 0) {
      return send(res, 200, { status: 'ClinicOS consult module running', time: new Date().toISOString() });
    }

    return send(res, 404, { error: 'Route not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'Internal server error', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`ClinicOS consult module listening on http://localhost:${PORT}`);
});
