const db = require('../db');
const billingEngine = require('../billingEngine');
const sse = require('../sse');

const VALID_TYPES = ['chat', 'call', 'video'];

module.exports = {
  // POST /api/sessions/start  { patientId, doctorId, type: chat|call|video }
  start(body) {
    const { patientId, doctorId, type } = body || {};
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

    // Prevent duplicate calls: check if doctor has an active or pending session
    const doctorBusy = db.sessions.where(
      (s) => s.doctorId === doctorId && (s.status === 'active' || s.status === 'pending')
    )[0];
    if (doctorBusy) {
      return { status: 409, body: { error: 'Doctor is currently in another consultation or attending another call' } };
    }

    // Prevent patient from creating multiple simultaneous requests
    const patientBusy = db.sessions.where(
      (s) => s.patientId === patientId && (s.status === 'active' || s.status === 'pending')
    )[0];
    if (patientBusy) {
      return { status: 409, body: { error: 'You already have an ongoing or pending consultation request' } };
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

    const now = new Date().toISOString();

    // ALL CONSULTATION TYPES (chat, call, video): must create a PENDING request,
    // NOT active, NOT billable yet until doctor accepts.
    const session = db.sessions.insert({
      patientId,
      doctorId,
      type,
      status: 'pending',
      ratePerMin,
      elapsedSec: 0,
      amountCharged: 0,
      requestedAt: now,
      acceptedAt: null,
      billingStartTime: null,
      startTime: null,
      endedAt: null,
      channelName: `consult_${db.genId()}`,
      messages: [],
    });

    // Notify doctor immediately via real-time SSE stream without requiring a refresh
    sse.notifyDoctor(doctorId, {
      event: 'incoming_call',
      sessionId: session.id,
      type: session.type,
      patientId: patient.id,
      patientName: patient.name,
      patientPhone: patient.phone || '',
      ratePerMin: session.ratePerMin,
      requestedAt: session.requestedAt,
    });

    // Safe auto-expiry timeout (45s) if doctor does not answer
    const expTimer = setTimeout(() => {
      const current = db.sessions.find(session.id);
      if (current && current.status === 'pending') {
        const expTime = new Date().toISOString();
        db.sessions.update(session.id, {
          status: 'expired',
          endedAt: expTime,
          endTime: expTime,
          endedReason: 'no_answer',
          amountCharged: 0,
          elapsedSec: 0,
          billingStartTime: null,
        });
        sse.broadcast(session.id, {
          event: 'session_ended',
          sessionId: session.id,
          reason: 'no_answer',
          amountCharged: 0,
          elapsedSec: 0,
        });
        sse.notifyDoctor(session.doctorId, {
          event: 'call_cancelled',
          sessionId: session.id,
        });
      }
    }, 45000);
    if (typeof expTimer.unref === 'function') expTimer.unref();

    return {
      status: 201,
      body: {
        ...session,
        eventsUrl: `/api/sessions/${session.id}/events`,
        billingTickSeconds: billingEngine.TICK_SEC,
      },
    };
  },

  // POST /api/sessions/:id/accept
  accept(id, doctorId) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };

    if (doctorId && session.doctorId !== doctorId) {
      return { status: 403, body: { error: 'You are not authorized to accept this consultation' } };
    }

    // Idempotency: if already accepted, return ok
    if (session.status === 'active') {
      return { status: 200, body: session };
    }

    if (session.status !== 'pending') {
      return { status: 409, body: { error: `Cannot accept session with status: ${session.status}` } };
    }

    const now = new Date().toISOString();
    const updated = db.sessions.update(id, {
      status: 'active',
      acceptedAt: now,
      billingStartTime: now,
      startTime: now,
      elapsedSec: 0,
      amountCharged: 0,
    });

    db.doctors.update(session.doctorId, { status: 'busy' });
    billingEngine.startBilling(id);

    // Notify patient and doctor listeners that call is accepted and WebRTC should start
    sse.broadcast(id, {
      event: 'call_accepted',
      sessionId: id,
      session: updated,
    });
    sse.notifyDoctor(session.doctorId, {
      event: 'call_accepted',
      sessionId: id,
      session: updated,
    });

    return { status: 200, body: updated };
  },

  // POST /api/sessions/:id/reject
  reject(id, doctorId) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };

    if (doctorId && session.doctorId !== doctorId) {
      return { status: 403, body: { error: 'You are not authorized to decline this consultation' } };
    }

    // Idempotency: if already rejected, return ok
    if (session.status === 'rejected') {
      return { status: 200, body: session };
    }

    if (session.status !== 'pending') {
      return { status: 409, body: { error: `Cannot reject session with status: ${session.status}` } };
    }

    const now = new Date().toISOString();
    const updated = db.sessions.update(id, {
      status: 'rejected',
      endedAt: now,
      endTime: now,
      endedReason: 'rejected',
      amountCharged: 0,
      elapsedSec: 0,
      billingStartTime: null,
    });

    db.doctors.update(session.doctorId, { status: 'online' });

    sse.broadcast(id, {
      event: 'call_rejected',
      sessionId: id,
      reason: 'Doctor declined the call',
      amountCharged: 0,
      elapsedSec: 0,
    });
    sse.notifyDoctor(session.doctorId, {
      event: 'call_rejected',
      sessionId: id,
    });

    return { status: 200, body: updated };
  },

  // POST /api/sessions/:id/end
  end(id) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };

    if (session.status === 'pending') {
      // Patient hung up or cancelled while ringing: no charges apply
      const now = new Date().toISOString();
      const updated = db.sessions.update(id, {
        status: 'cancelled',
        endedAt: now,
        endTime: now,
        endedReason: 'cancelled',
        amountCharged: 0,
        elapsedSec: 0,
        billingStartTime: null,
      });

      db.doctors.update(session.doctorId, { status: 'online' });

      sse.broadcast(id, {
        event: 'session_ended',
        sessionId: id,
        reason: 'cancelled',
        amountCharged: 0,
        elapsedSec: 0,
      });
      sse.notifyDoctor(session.doctorId, {
        event: 'call_cancelled',
        sessionId: id,
      });

      return { status: 200, body: updated };
    }

    if (session.status !== 'active') {
      return { status: 200, body: session };
    }

    const ended = billingEngine.endSession(id, 'manual');
    return { status: 200, body: ended };
  },

  // GET /api/sessions/:id
  get(id) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    return { status: 200, body: session };
  },

  // GET /api/sessions/:id/events  (SSE stream)
  events(id, res) {
    const session = db.sessions.find(id);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Session not found' }));
    }
    sse.subscribe(id, res);
  },

  // POST /api/sessions/:id/chat  { sender: 'patient'|'doctor', message, type?, attachment? }
  chat(id, body) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    if (session.type !== 'chat') {
      return { status: 400, body: { error: 'This session is not a chat session' } };
    }
    if (['ended', 'rejected', 'cancelled', 'expired'].includes(session.status)) {
      return { status: 409, body: { error: 'Consultation has ended' } };
    }

    const msg = {
      id: db.genId(),
      sender: body && body.sender ? body.sender : 'patient',
      message: body && body.message ? String(body.message) : '',
      type: (body && body.type) || (body && body.attachment ? body.attachment.type : 'text'),
      attachment: (body && body.attachment) || null,
      at: new Date().toISOString(),
      isPreAcceptance: session.status === 'pending',
    };

    const currentMessages = Array.isArray(session.messages) ? session.messages : [];
    currentMessages.push(msg);
    db.sessions.update(id, { messages: currentMessages });

    if (msg.attachment && msg.attachment.id) {
      db.attachments.update(msg.attachment.id, { sessionId: id });
    }

    sse.broadcast(id, {
      event: 'chat_message',
      sessionId: id,
      ...msg,
    });
    return { status: 200, body: { delivered: true, message: msg } };
  },

  // GET /api/sessions/:id/messages
  messages(id) {
    const session = db.sessions.find(id);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    return { status: 200, body: { messages: session.messages || [] } };
  },

  // POST /api/sessions/:id/signal  { from: 'caller'|'callee', data: {...} }
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
