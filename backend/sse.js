// sse.js
// Lightweight real-time layer using Server-Sent Events (built into HTTP,
// no external ws library needed). Each session has a room of subscribers
// (patient + doctor's browser tabs). Used for: live per-minute balance
// ticks, session-ended events, and chat messages for chat-type sessions.

const rooms = new Map(); // sessionId -> Set of res objects
const doctorRooms = new Map(); // doctorId -> Set of res objects

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

function subscribe(sessionId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': getCorsOrigin(res.req),
    'Vary': 'Origin',
  });
  res.write(`event: connected\ndata: {"sessionId":"${sessionId}"}\n\n`);

  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  rooms.get(sessionId).add(res);

  res.req.on('close', () => {
    rooms.get(sessionId)?.delete(res);
  });
}

function broadcast(sessionId, payload) {
  const subs = rooms.get(sessionId);
  if (!subs) return;
  const data = `event: ${payload.event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    try {
      res.write(data);
    } catch (e) {
      /* ignore socket write errors */
    }
  }
}

function subscribeDoctor(doctorId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': getCorsOrigin(res.req),
    'Vary': 'Origin',
  });
  res.write(`event: connected\ndata: {"doctorId":"${doctorId}"}\n\n`);

  if (!doctorRooms.has(doctorId)) doctorRooms.set(doctorId, new Set());
  doctorRooms.get(doctorId).add(res);

  res.req.on('close', () => {
    doctorRooms.get(doctorId)?.delete(res);
  });
}

function notifyDoctor(doctorId, payload) {
  const subs = doctorRooms.get(doctorId);
  if (!subs) return;
  const data = `event: ${payload.event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    try {
      res.write(data);
    } catch (e) {
      /* ignore socket write errors */
    }
  }
}

module.exports = { subscribe, broadcast, subscribeDoctor, notifyDoctor };
