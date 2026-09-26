// test_sessions_billing.js
// Automated verification suite for Dexa Consult Call & Video Call lifecycle,
// zero-billing while pending, acceptance, rejection, cancellation, and duplicate prevention.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
const patientsBackup = fs.readFileSync(path.join(dataDir, 'patients.json'), 'utf8');
const doctorsBackup = fs.readFileSync(path.join(dataDir, 'doctors.json'), 'utf8');
const sessionsBackup = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');

function restoreData() {
  fs.writeFileSync(path.join(dataDir, 'patients.json'), patientsBackup);
  fs.writeFileSync(path.join(dataDir, 'doctors.json'), doctorsBackup);
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), sessionsBackup);
}

const db = require('./db');
const sessionsCtrl = require('./routes/sessions');
const billingEngine = require('./billingEngine');
const sse = require('./sse');

let passedTests = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function main() {
  console.log('=== RUNNING CALL & VIDEO CALL BILLING ENGINE TESTS ===\n');
  try {
    // Setup test doctor and test patient
  const testDoctor = db.doctors.insert({
    name: 'Dr. Test Specialist',
    email: `dr.test.${Date.now()}@example.com`,
    passwordSalt: 'salt',
    passwordHash: 'hash',
    specialization: 'Dermatology',
    status: 'online',
    rates: { chat: 10, call: 20, video: 30 },
  });

  const testPatient = db.patients.insert({
    name: 'Test Patient',
    email: `pat.test.${Date.now()}@example.com`,
    passwordSalt: 'salt',
    passwordHash: 'hash',
    phone: '9876543210',
    walletBalance: 200.0,
  });

  // Track SSE notifications for the doctor
  let receivedDoctorNotifications = [];
  const fakeDoctorRes = {
    writeHead() {},
    write(str) {
      const match = str.match(/event:\s*([^\n]+)\ndata:\s*([^\n]+)/);
      if (match) {
        try {
          receivedDoctorNotifications.push({ event: match[1], data: JSON.parse(match[2]) });
        } catch (e) {}
      }
    },
    req: { on() {} },
  };
  sse.subscribeDoctor(testDoctor.id, fakeDoctorRes);

  // 1. Patient clicks Call -> pending incoming call created, NOT active, NOT billable
  let callSessionId = null;
  test('Call creates pending session with zero billing and null billingStartTime', () => {
    const res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'call',
    });

    assert.strictEqual(res.status, 201, 'Should return status 201');
    const s = res.body;
    callSessionId = s.id;

    assert.strictEqual(s.status, 'pending', 'Status must be pending');
    assert.strictEqual(s.amountCharged, 0, 'amountCharged must be 0 before doctor acceptance');
    assert.strictEqual(s.elapsedSec, 0, 'elapsedSec must be 0 before doctor acceptance');
    assert.strictEqual(s.billingStartTime, null, 'billingStartTime must be null before acceptance');
    assert.ok(s.requestedAt, 'requestedAt timestamp must be recorded');
    assert.strictEqual(s.acceptedAt, null, 'acceptedAt must be null before acceptance');

    // Verify patient wallet was NOT charged
    const pat = db.patients.find(testPatient.id);
    assert.strictEqual(pat.walletBalance, 200.0, 'Patient balance must be untouched while pending');

    // Verify doctor received incoming_call notification
    const incomingEvt = receivedDoctorNotifications.find(
      (n) => n.event === 'incoming_call' && n.data.sessionId === s.id
    );
    assert.ok(incomingEvt, 'Doctor must receive incoming_call notification via SSE');
    assert.strictEqual(incomingEvt.data.type, 'call');
    assert.strictEqual(incomingEvt.data.patientName, testPatient.name);
    assert.strictEqual(incomingEvt.data.ratePerMin, 20);
  });

  // 2. Prevent duplicate calls while doctor or patient has a pending request
  test('Prevent duplicate calls to busy/pending doctor or from busy/pending patient', () => {
    const dupRes = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'call',
    });
    assert.strictEqual(dupRes.status, 409, 'Must prevent duplicate call while pending');
  });

  // 3. Doctor rejects call -> session ended as rejected with 0 billing, doctor freed
  test('Doctor reject ends session as rejected with 0 amount charged and doctor freed', () => {
    const rejRes = sessionsCtrl.reject(callSessionId, testDoctor.id);
    assert.strictEqual(rejRes.status, 200, 'Reject should return status 200');
    assert.strictEqual(rejRes.body.status, 'rejected', 'Status must be rejected');
    assert.strictEqual(rejRes.body.amountCharged, 0, 'amountCharged must remain 0');
    assert.strictEqual(rejRes.body.billingStartTime, null, 'billingStartTime must remain null');

    const pat = db.patients.find(testPatient.id);
    assert.strictEqual(pat.walletBalance, 200.0, 'Patient balance must remain 200.0 after reject');

    const doc = db.doctors.find(testDoctor.id);
    assert.strictEqual(doc.status, 'online', 'Doctor status must be online');

    // Idempotent reject
    const rejAgain = sessionsCtrl.reject(callSessionId, testDoctor.id);
    assert.strictEqual(rejAgain.status, 200, 'Idempotent reject should succeed');
  });

  // 4. Cannot accept an already rejected session
  test('Cannot accept an already rejected session', () => {
    const accRej = sessionsCtrl.accept(callSessionId, testDoctor.id);
    assert.strictEqual(accRej.status, 409, 'Cannot accept a rejected session');
  });

  // 5. Patient cancels pending call while ringing
  let cancelSessionId = null;
  test('Patient cancels pending call before answer -> cancelled with 0 billing', () => {
    const res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'call',
    });
    assert.strictEqual(res.status, 201);
    cancelSessionId = res.body.id;

    // Patient hangs up / cancels
    const endRes = sessionsCtrl.end(cancelSessionId);
    assert.strictEqual(endRes.status, 200);
    assert.strictEqual(endRes.body.status, 'cancelled');
    assert.strictEqual(endRes.body.amountCharged, 0);

    const pat = db.patients.find(testPatient.id);
    assert.strictEqual(pat.walletBalance, 200.0, 'Wallet balance untouched after cancellation');

    const doc = db.doctors.find(testDoctor.id);
    assert.strictEqual(doc.status, 'online', 'Doctor remains online');
  });

  // 6. Call accepted by Doctor -> becomes active, billingStartTime recorded, billing starts
  let activeCallId = null;
  await runAsyncTest('Doctor accepts call -> becomes active, billingStartTime recorded, billing begins', async () => {
    const res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'call',
    });
    assert.strictEqual(res.status, 201);
    activeCallId = res.body.id;

    // Doctor accepts
    const accRes = sessionsCtrl.accept(activeCallId, testDoctor.id);
    assert.strictEqual(accRes.status, 200);
    const activeSession = accRes.body;

    assert.strictEqual(activeSession.status, 'active');
    assert.ok(activeSession.acceptedAt, 'acceptedAt must be recorded');
    assert.ok(activeSession.billingStartTime, 'billingStartTime must be recorded upon acceptance');
    assert.strictEqual(activeSession.amountCharged, 0, 'amountCharged is 0 right at acceptance');

    const doc = db.doctors.find(testDoctor.id);
    assert.strictEqual(doc.status, 'busy', 'Doctor status must be busy while call is active');

    // Idempotent accept
    const accAgain = sessionsCtrl.accept(activeCallId, testDoctor.id);
    assert.strictEqual(accAgain.status, 200);

    // Wait a brief moment to confirm billing timer is active, then manually trigger billingEngine tick or wait
    // Calling end stops billing
    const endRes = sessionsCtrl.end(activeCallId);
    assert.strictEqual(endRes.status, 200);
    assert.strictEqual(endRes.body.status, 'ended');
    assert.ok(endRes.body.endTime);

    const docAfter = db.doctors.find(testDoctor.id);
    assert.strictEqual(docAfter.status, 'online', 'Doctor is freed to online after session ends');
  });

  // 7. VIDEO CALL Lifecycle: pending -> accepted -> billable -> ended
  let videoSessionId = null;
  await runAsyncTest('Video call lifecycle: pending -> accepted -> active -> billable -> ended', async () => {
    // Start video call
    const res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'video',
    });
    assert.strictEqual(res.status, 201);
    videoSessionId = res.body.id;

    assert.strictEqual(res.body.status, 'pending', 'Video must start in pending state');
    assert.strictEqual(res.body.billingStartTime, null, 'Video billingStartTime must be null while pending');
    assert.strictEqual(res.body.amountCharged, 0, 'Video amountCharged must be 0 while pending');

    // Accept video
    const accRes = sessionsCtrl.accept(videoSessionId, testDoctor.id);
    assert.strictEqual(accRes.status, 200);
    assert.strictEqual(accRes.body.status, 'active');
    assert.ok(accRes.body.billingStartTime);
    assert.ok(accRes.body.acceptedAt);

    // End video
    const endRes = sessionsCtrl.end(videoSessionId);
    assert.strictEqual(endRes.status, 200);
    assert.strictEqual(endRes.body.status, 'ended');
    assert.ok(endRes.body.billingStartTime, 'billingStartTime must be preserved on ended session');
    assert.ok(typeof endRes.body.elapsedSec === 'number', 'elapsedSec must be a number');

    const docAfter = db.doctors.find(testDoctor.id);
    assert.strictEqual(docAfter.status, 'online');
  });

  // 8. Chat lifecycle aligned: pending -> doctor accepts -> active -> billing begins -> ended
  await runAsyncTest('Chat lifecycle aligned: pending -> doctor accepts -> active -> billing begins -> ended', async () => {
    const res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    assert.strictEqual(res.status, 201);
    const chatSession = res.body;

    assert.strictEqual(chatSession.status, 'pending', 'Chat session must start as pending');
    assert.strictEqual(chatSession.billingStartTime, null, 'billingStartTime must be null while pending');
    assert.strictEqual(chatSession.amountCharged, 0, 'amountCharged must be 0 while pending');
    assert.strictEqual(chatSession.ratePerMin, 10);

    const docBeforeAccept = db.doctors.find(testDoctor.id);
    assert.strictEqual(docBeforeAccept.status, 'online', 'Doctor remains online until accepting chat');

    // Doctor accepts chat
    const accRes = sessionsCtrl.accept(chatSession.id, testDoctor.id);
    assert.strictEqual(accRes.status, 200);
    assert.strictEqual(accRes.body.status, 'active');
    assert.ok(accRes.body.billingStartTime, 'billingStartTime must be set upon acceptance');

    const docBusy = db.doctors.find(testDoctor.id);
    assert.strictEqual(docBusy.status, 'busy');

    // End chat
    const endRes = sessionsCtrl.end(chatSession.id);
    assert.strictEqual(endRes.status, 200);
    assert.strictEqual(endRes.body.status, 'ended');

    const docAfter = db.doctors.find(testDoctor.id);
    assert.strictEqual(docAfter.status, 'online');
  });

    console.log(`\nALL ${passedTests} TESTS PASSED SUCCESSFULLY!`);
  } catch (err) {
    console.error('Test runner error:', err);
    process.exitCode = 1;
  } finally {
    restoreData();
    console.log('Database files restored to original state.');
    process.exit(process.exitCode || 0);
  }
}

main();
