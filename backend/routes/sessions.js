const db = require('../db');
const billingEngine = require('../billingEngine');
const sse = require('../sse');

const VALID_TYPES = ['chat', 'call', 'video'];

module.exports = {
  // POST /api/sessions/start  { patientId, doctorId, type: chat|call|video }
  start(body) {
    const { patientId, doctorId, type } = body;
    if (!VALID_TYPES.includes(type)) {
      return { status: 400, body: { error: `type must be one of ${VALID_TYPES.join(', ')}` } };
    }
    const patient = db.patients.find(patientId);
    if (!patient) return { status: 404, body: { error: 'Patient not found' } };

    const doctor = db.doctors.find(doctorId);
    if (!doctor) return { status: 404, body: { error: 'Doctor not found' } };
    if (doctor.status !== 'online') {
      return { status: 409, body: { error: 'Doctor is not available right now' } };
    }

    const ratePerMin = doctor.rates[type];
    if (!ratePerMin || ratePerMin <= 0) {
      return { status: 400, body: { error: `Doctor has no rate configured for ${type}` } };
    }
    if (patient.walletBalance < ratePerMin) {
      return {
        status: 402,
        body: {
          error: 'Insufficient wallet balance to start this consultation',
          requiredForFirstMinute: ratePerMin,
          walletBalance: patient.walletBalance,
        },
      };
    }

    const session = db.sessions.insert({
      patientId,
      doctorId,
      type,
      status: 'active',
      ratePerMin,
      elapsedSec: 0,
      amountCharged: 0,
      startTime: new Date().toISOString(),
      // In production: generate the actual call/video join token here.
      // e.g. Agora: RtcTokenBuilder.buildTokenWithUid(...)
      //      Twilio: AccessToken with VideoGrant
      // For this prototype we just return a placeholder channel name that
      // your frontend can use as the Agora/Twilio channel/room id.
      channelName: `consult_${db.genId()}`,
    });

    db.doctors.update(doctorId, { status: 'busy' });
    billingEngine.startBilling(session.id);

    return {
      status: 201,
      body: {
        ...session,
        eventsUrl: `/api/sessions/${session.id}/events`,
        billingTickSeconds: billingEngine.TICK_SEC,
      },
    };
  },

  // POST /api/sessions/:id/end
  end(id) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    if (session.status !== 'active') return { status: 200, body: session };
    const ended = billingEngine.endSession(id, 'manual');
    return { status: 200, body: ended };
  },

  // GET /api/sessions/:id
  get(id) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    return { status: 200, body: session };
  },

  // GET /api/sessions/:id/events  (SSE stream — call this from the frontend
  // with an EventSource to get live balance ticks + chat messages)
  events(id, res) {
    const session = db.sessions.find(id);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Session not found' }));
    }
    sse.subscribe(id, res);
  },

  // POST /api/sessions/:id/chat  { sender: 'patient'|'doctor', message }
  chat(id, body) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    if (session.type !== 'chat') {
      return { status: 400, body: { error: 'This session is not a chat session' } };
    }
    if (session.status !== 'active') {
      return { status: 409, body: { error: 'Session has ended' } };
    }
    sse.broadcast(id, {
      event: 'chat_message',
      sessionId: id,
      sender: body.sender,
      message: body.message,
      at: new Date().toISOString(),
    });
    return { status: 200, body: { delivered: true } };
  },

  // POST /api/sessions/:id/signal  { from: 'caller'|'callee', data: {...} }
  // Pure relay for WebRTC signaling (SDP offers/answers, ICE candidates).
  // Rides the same SSE room as billing ticks and chat — no separate
  // signaling server needed. Works for STUN-reachable networks; add a
  // TURN server for reliability across strict corporate/mobile NATs.
  signal(id, body) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    if (session.status !== 'active') {
      return { status: 409, body: { error: 'Session has ended' } };
    }
    sse.broadcast(id, {
      event: 'signal',
      sessionId: id,
      from: body.from,
      data: body.data,
    });
    return { status: 200, body: { delivered: true } };
  },
};
