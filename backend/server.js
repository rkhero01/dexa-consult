// server.js
// Entry point. Pure Node `http` module — no Express needed, so this runs
// with zero `npm install`. CORS is wide open here so your separate website
// (different domain) can call these APIs directly from the browser; lock
// `Access-Control-Allow-Origin` down to your real domain before going live.

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// Zero-dependency .env loader
function loadEnvFile(envPath) {
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {}
}
loadEnvFile(path.resolve(__dirname, '../.env'));
loadEnvFile(path.resolve(__dirname, '.env'));

const doctorsCtrl = require('./routes/doctors');
const walletCtrl = require('./routes/wallet');
const sessionsCtrl = require('./routes/sessions');
const authCtrl = require('./auth');
const meDoctorCtrl = require('./routes/meDoctor');
const mePatientCtrl = require('./routes/mePatient');

const PORT = process.env.PORT || 4000;
const ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=UTF-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const ALLOWED_ORIGINS = [
  'https://rkhero01.github.io',
  'https://dexa-consult.onrender.com',
  'http://localhost:4000',
  'http://localhost:4001',
  'http://localhost:3000',
  'http://127.0.0.1:4000',
  'http://127.0.0.1:4001',
  'http://127.0.0.1:3000',
];

function getCorsOrigin(req) {
  const reqOrigin = (req && req.headers ? req.headers['origin'] : '') || '';
  if (!reqOrigin) return 'https://rkhero01.github.io';
  if (ALLOWED_ORIGINS.includes(reqOrigin) || reqOrigin.endsWith('.github.io')) {
    return reqOrigin;
  }
  return 'https://rkhero01.github.io';
}

function serveStaticFile(res, filePath, isHead = false) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const origin = getCorsOrigin(res.req);
    if (isHead) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': origin,
        'Vary': 'Origin',
      });
      res.end();
      return true;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
    });
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

function send(res, status, body) {
  const origin = getCorsOrigin(res.req);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
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
    const origin = getCorsOrigin(req);
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
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
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'doctor' && parts[3] === 'events' && req.method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      const match = authHeader.match(/^Bearer (.+)$/);
      const token = match ? match[1] : (url.searchParams.get('token') || '');
      const doctor = authCtrl.authenticateDoctor({ headers: { authorization: `Bearer ${token}` } });
      if (!doctor) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': getCorsOrigin(req), 'Vary': 'Origin' });
        return res.end(JSON.stringify({ error: 'Login required' }));
      }
      return require('./sse').subscribeDoctor(doctor.id, res);
    }

    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams);

    // --- Auth (self-serve signup / login / password reset) ---
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'doctor' && parts[3] === 'signup' && req.method === 'POST') {
      return reply(res, authCtrl.doctorSignup(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'doctor' && parts[3] === 'login' && req.method === 'POST') {
      return reply(res, authCtrl.doctorLogin(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'doctor' && parts[3] === 'forgot-password' && req.method === 'POST') {
      return reply(res, authCtrl.doctorForgotPassword(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'doctor' && parts[3] === 'reset-password' && req.method === 'POST') {
      return reply(res, authCtrl.doctorResetPassword(body));
    }

    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'patient' && parts[3] === 'signup' && req.method === 'POST') {
      return reply(res, authCtrl.patientSignup(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'patient' && parts[3] === 'login' && req.method === 'POST') {
      return reply(res, authCtrl.patientLogin(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'patient' && parts[3] === 'forgot-password' && req.method === 'POST') {
      return reply(res, authCtrl.patientForgotPassword(body));
    }
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'patient' && parts[3] === 'reset-password' && req.method === 'POST') {
      return reply(res, authCtrl.patientResetPassword(body));
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
    if (parts[0] === 'api' && parts[1] === 'me' && parts[2] === 'patient' && parts.length === 3) {
      if (req.method === 'GET') return reply(res, mePatientCtrl.profile(req));
      if (req.method === 'PATCH') return reply(res, mePatientCtrl.update(req, body));
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
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'accept' && req.method === 'POST') {
      const doctor = authCtrl.authenticateDoctor(req);
      return reply(res, sessionsCtrl.accept(parts[2], doctor ? doctor.id : null));
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'reject' && req.method === 'POST') {
      const doctor = authCtrl.authenticateDoctor(req);
      return reply(res, sessionsCtrl.reject(parts[2], doctor ? doctor.id : null));
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

    // Health check endpoint
    if (parts[0] === 'api' && parts[1] === 'health') {
      return send(res, 200, { status: 'ClinicOS consult module running', time: new Date().toISOString() });
    }

    // Static files & Root handler
    if (['GET', 'HEAD'].includes(req.method) && parts[0] !== 'api') {
      const isHead = req.method === 'HEAD';
      if (parts.length === 0) {
        // If visiting root in a browser, serve platform.html; otherwise return health check
        const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
        if (acceptsHtml) {
          const platformPath = path.join(ROOT_DIR, 'platform.html');
          if (serveStaticFile(res, platformPath, isHead)) return;
        }
        return send(res, 200, { status: 'ClinicOS consult module running', time: new Date().toISOString() });
      }

      // Serve requested static file (e.g. /platform.html, /index.html, /Image/...)
      const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(ROOT_DIR, safePath);
      // Prevent directory traversal
      if (filePath.startsWith(ROOT_DIR) && serveStaticFile(res, filePath, isHead)) {
        return;
      }
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
