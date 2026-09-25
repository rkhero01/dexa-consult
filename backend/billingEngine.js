// billingEngine.js
// Runs a background tick for every ACTIVE session. Every TICK_SEC seconds it
// works out how much that slice of time cost (based on the doctor's
// per-minute rate for that consultation type: chat / call / video), deducts
// it from the patient's wallet, logs a transaction, and pushes a live update
// out over SSE. If the wallet can't cover the next tick, the session is
// auto-ended — exactly like Astrotalk/Practo do it.

const db = require('./db');
const { broadcast } = require('./sse');

const TICK_SEC = 10; // billing granularity; lower = smoother but more writes
const PLATFORM_COMMISSION_PCT = 20; // clinic's cut from each doctor's earnings

const timers = new Map(); // sessionId -> interval handle

function ratePerSecond(doctor, type) {
  const perMin = doctor.rates[type];
  return perMin / 60;
}

function startBilling(sessionId) {
  if (timers.has(sessionId)) return; // already running

  const handle = setInterval(() => {
    const session = db.sessions.find(sessionId);
    if (!session || session.status !== 'active' || !session.billingStartTime) {
      stopBilling(sessionId);
      return;
    }

    const doctor = db.doctors.find(session.doctorId);
    const patient = db.patients.find(session.patientId);
    if (!doctor || !patient) {
      endSession(sessionId, 'error');
      return;
    }

    const cost = +(ratePerSecond(doctor, session.type) * TICK_SEC).toFixed(2);

    if (patient.walletBalance < cost) {
      // Not enough for the next tick — end the call right here.
      endSession(sessionId, 'low_balance');
      return;
    }

    const newBalance = +(patient.walletBalance - cost).toFixed(2);
    db.patients.update(patient.id, { walletBalance: newBalance });

    db.transactions.insert({
      patientId: patient.id,
      doctorId: doctor.id,
      sessionId,
      type: 'debit',
      amount: cost,
      note: `${session.type} consult tick (${TICK_SEC}s)`,
    });

    const now = Date.now();
    const billingStartMs = new Date(session.billingStartTime).getTime();
    const elapsedSec = Math.max(0, Math.floor((now - billingStartMs) / 1000));
    const amountCharged = +((session.amountCharged || 0) + cost).toFixed(2);
    db.sessions.update(sessionId, { elapsedSec, amountCharged });

    broadcast(sessionId, {
      event: 'tick',
      sessionId,
      elapsedSec,
      amountCharged,
      walletBalance: newBalance,
      ratePerMin: doctor.rates[session.type],
    });
  }, TICK_SEC * 1000);

  timers.set(sessionId, handle);
}

function stopBilling(sessionId) {
  const handle = timers.get(sessionId);
  if (handle) {
    clearInterval(handle);
    timers.delete(sessionId);
  }
}

function endSession(sessionId, reason = 'manual') {
  const session = db.sessions.find(sessionId);
  if (!session || session.status !== 'active') return session;

  stopBilling(sessionId);

  const now = new Date().toISOString();
  let elapsedSec = session.elapsedSec || 0;
  if (session.billingStartTime) {
    elapsedSec = Math.max(0, Math.floor((new Date(now).getTime() - new Date(session.billingStartTime).getTime()) / 1000));
  }

  const updated = db.sessions.update(sessionId, {
    status: 'ended',
    endedReason: reason,
    endTime: now,
    endedAt: now,
    elapsedSec,
  });

  broadcast(sessionId, {
    event: 'session_ended',
    sessionId,
    reason,
    amountCharged: updated.amountCharged || 0,
    elapsedSec: updated.elapsedSec || 0,
  });

  // free up the doctor
  db.doctors.update(session.doctorId, { status: 'online' });

  return updated;
}

function doctorEarnings(doctorId) {
  const sessions = db.sessions.where(
    (s) => s.doctorId === doctorId && s.status === 'ended'
  );
  const gross = +sessions.reduce((sum, s) => sum + (s.amountCharged || 0), 0).toFixed(2);
  const commission = +((gross * PLATFORM_COMMISSION_PCT) / 100).toFixed(2);
  const net = +(gross - commission).toFixed(2);
  return {
    doctorId,
    totalSessions: sessions.length,
    grossEarnings: gross,
    platformCommission: commission,
    netPayout: net,
    commissionPct: PLATFORM_COMMISSION_PCT,
  };
}

module.exports = { startBilling, stopBilling, endSession, doctorEarnings, TICK_SEC };
