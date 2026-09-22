// sse.js
// Lightweight real-time layer using Server-Sent Events (built into HTTP,
// no external ws library needed). Each session has a room of subscribers
// (patient + doctor's browser tabs). Used for: live per-minute balance
// ticks, session-ended events, and chat messages for chat-type sessions.

const rooms = new Map(); // sessionId -> Set of res objects

function subscribe(sessionId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
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
    res.write(data);
  }
}

module.exports = { subscribe, broadcast };
