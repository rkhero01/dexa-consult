// test_chat_system.js
// Dedicated test suite verifying:
// 1. Patient creates chat -> pending
// 2. billingStartTime = null
// 3. Pending chat amount = ₹0
// 4. Doctor receives pending notification
// 5. Doctor rejects -> ₹0
// 6. Patient cancels pending -> ₹0
// 7. Doctor accepts -> active
// 8. billingStartTime gets server timestamp ONLY at acceptance
// 9. Billing duration excludes pending time
// 10. Ending chat calculates only active duration
// 11. Duplicate pending chat prevented
// 12. Text message still works
// 13. Image attachment upload works
// 14. Audio attachment upload works
// 15. File attachment upload works
// 16. Unauthorized attachment access rejected
// 17. Invalid file type rejected
// 18. Oversized file rejected
// 19. Patient receives accept/reject state in real time
// 20. Doctor receives incoming chat in real time

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
const patientsBackup = fs.readFileSync(path.join(dataDir, 'patients.json'), 'utf8');
const doctorsBackup = fs.readFileSync(path.join(dataDir, 'doctors.json'), 'utf8');
const sessionsBackup = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');
const transactionsBackup = fs.existsSync(path.join(dataDir, 'transactions.json'))
  ? fs.readFileSync(path.join(dataDir, 'transactions.json'), 'utf8')
  : '[]';
const attachmentsBackup = fs.existsSync(path.join(dataDir, 'attachments.json'))
  ? fs.readFileSync(path.join(dataDir, 'attachments.json'), 'utf8')
  : '[]';

function restoreData() {
  fs.writeFileSync(path.join(dataDir, 'patients.json'), patientsBackup);
  fs.writeFileSync(path.join(dataDir, 'doctors.json'), doctorsBackup);
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), sessionsBackup);
  fs.writeFileSync(path.join(dataDir, 'transactions.json'), transactionsBackup);
  fs.writeFileSync(path.join(dataDir, 'attachments.json'), attachmentsBackup);
}

const db = require('./db');
const sessionsCtrl = require('./routes/sessions');
const billingEngine = require('./billingEngine');
const sse = require('./sse');
const chatUpload = require('./routes/chatUpload');

let testCount = 0;
function pass(msg) {
  testCount++;
  console.log(`  ✓ Test ${testCount}: ${msg}`);
}

async function run() {
  console.log('=== RUNNING PRODUCTION CHAT SYSTEM & BILLING LIFECYCLE TESTS ===\n');

  try {
    // ---------------- Setup test entities ----------------
    const doctorToken = 'test_doc_token_' + Date.now();
    const testDoctor = db.doctors.insert({
      name: 'Dr. Chat Specialist',
      email: `chatdoc.${Date.now()}@example.com`,
      passwordSalt: 'salt',
      passwordHash: 'hash',
      specialization: 'Dermatology',
      status: 'online',
      authToken: doctorToken,
      rates: { chat: 30, call: 40, video: 50 },
    });

    const patientToken = 'test_pat_token_' + Date.now();
    const testPatient = db.patients.insert({
      name: 'Patient Alice',
      email: `alice.${Date.now()}@example.com`,
      passwordSalt: 'salt',
      passwordHash: 'hash',
      phone: '9988776655',
      authToken: patientToken,
      walletBalance: 300.0,
    });

    const strangerToken = 'test_stranger_token_' + Date.now();
    const strangerPatient = db.patients.insert({
      name: 'Stranger Bob',
      email: `bob.${Date.now()}@example.com`,
      passwordSalt: 'salt',
      passwordHash: 'hash',
      phone: '9988776654',
      authToken: strangerToken,
      walletBalance: 100.0,
    });

    // Capture doctor notifications
    const doctorNotifications = [];
    const doctorSSE = {
      writeHead() {},
      write(chunk) {
        const match = chunk.match(/event:\s*([^\n]+)\ndata:\s*([^\n]+)/);
        if (match) {
          try {
            doctorNotifications.push({ event: match[1], data: JSON.parse(match[2]) });
          } catch (e) {}
        }
      },
      req: { on() {} },
    };
    sse.subscribeDoctor(testDoctor.id, doctorSSE);

    // 1. Patient creates chat -> pending
    // 2. billingStartTime = null
    // 3. Pending chat amount = ₹0
    const startRes = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    assert.strictEqual(startRes.status, 201, 'Chat start should return 201 Created');
    const s1 = startRes.body;
    assert.strictEqual(s1.status, 'pending', '1. Chat status must be pending on creation');
    pass('Patient creates chat -> pending');

    assert.strictEqual(s1.billingStartTime, null, '2. billingStartTime must be null on pending chat');
    pass('billingStartTime = null');

    assert.strictEqual(s1.amountCharged, 0, '3. amountCharged must be 0 while pending');
    assert.strictEqual(s1.elapsedSec, 0, 'elapsedSec must be 0 while pending');
    const pat1 = db.patients.find(testPatient.id);
    assert.strictEqual(pat1.walletBalance, 300.0, 'Patient wallet must NOT be charged during pending');
    pass('Pending chat amount = ₹0');

    // 4. Doctor receives pending notification
    const incoming1 = doctorNotifications.find((n) => n.event === 'incoming_call' && n.data.sessionId === s1.id);
    assert.ok(incoming1, 'Doctor must receive real-time notification for pending chat');
    assert.strictEqual(incoming1.data.type, 'chat', 'Notification type must be chat');
    assert.strictEqual(incoming1.data.patientName, 'Patient Alice');
    pass('Doctor receives pending notification');

    // 5. Doctor rejects -> ₹0
    const rejRes = sessionsCtrl.reject(s1.id, testDoctor.id);
    assert.strictEqual(rejRes.status, 200);
    assert.strictEqual(rejRes.body.status, 'rejected', 'Session status must be rejected');
    assert.strictEqual(rejRes.body.amountCharged, 0, 'Amount charged must be 0 on rejection');
    assert.strictEqual(rejRes.body.billingStartTime, null, 'billingStartTime must remain null');
    const patAfterRej = db.patients.find(testPatient.id);
    assert.strictEqual(patAfterRej.walletBalance, 300.0, 'Patient wallet balance preserved at ₹300');
    const docAfterRej = db.doctors.find(testDoctor.id);
    assert.strictEqual(docAfterRej.status, 'online', 'Doctor status returned to online');
    pass('Doctor rejects -> ₹0');

    // 6. Patient cancels pending -> ₹0
    const s2Res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    const s2 = s2Res.body;
    assert.strictEqual(s2.status, 'pending');

    const cancelRes = sessionsCtrl.end(s2.id);
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelRes.body.status, 'cancelled', 'Session status must be cancelled');
    assert.strictEqual(cancelRes.body.amountCharged, 0, 'Cancelled chat charged amount must be 0');
    assert.strictEqual(cancelRes.body.billingStartTime, null, 'billingStartTime must remain null');
    const patAfterCancel = db.patients.find(testPatient.id);
    assert.strictEqual(patAfterCancel.walletBalance, 300.0);
    const docAfterCancel = db.doctors.find(testDoctor.id);
    assert.strictEqual(docAfterCancel.status, 'online');
    pass('Patient cancels pending -> ₹0');

    // 7. Doctor accepts -> active
    // 8. billingStartTime gets server timestamp ONLY at acceptance
    const s3Res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    const s3 = s3Res.body;
    assert.strictEqual(s3.status, 'pending');
    assert.strictEqual(s3.billingStartTime, null);

    // Track session SSE events
    const sessionEvents = [];
    const sessionSSE = {
      writeHead() {},
      write(chunk) {
        const match = chunk.match(/event:\s*([^\n]+)\ndata:\s*([^\n]+)/);
        if (match) {
          try {
            sessionEvents.push({ event: match[1], data: JSON.parse(match[2]) });
          } catch (e) {}
        }
      },
      req: { on() {} },
    };
    sse.subscribe(s3.id, sessionSSE);

    // Accept session
    const beforeAcceptTime = Date.now();
    const accRes = sessionsCtrl.accept(s3.id, testDoctor.id);
    const afterAcceptTime = Date.now();

    assert.strictEqual(accRes.status, 200);
    const s3Active = accRes.body;
    assert.strictEqual(s3Active.status, 'active', '7. Session status must be active after acceptance');
    pass('Doctor accepts -> active');

    assert.ok(s3Active.billingStartTime, '8. billingStartTime must be set upon acceptance');
    const acceptTimestamp = new Date(s3Active.billingStartTime).getTime();
    assert.ok(
      acceptTimestamp >= beforeAcceptTime - 1000 && acceptTimestamp <= afterAcceptTime + 1000,
      'billingStartTime must match current server timestamp'
    );
    assert.strictEqual(s3Active.amountCharged, 0, 'Amount charged is 0 right at acceptance');
    pass('billingStartTime gets server timestamp ONLY at acceptance');

    // 9. Billing duration excludes pending time
    // 10. Ending chat calculates only active duration
    // Simulate pending time was 60 seconds earlier than billingStartTime
    const simulatedPendingRequestedAt = new Date(acceptTimestamp - 60000).toISOString();
    db.sessions.update(s3.id, { requestedAt: simulatedPendingRequestedAt });

    // Simulate 20 seconds of active elapsed time
    const simulatedEnd = new Date(acceptTimestamp + 20000).toISOString();
    // End session
    const endRes = billingEngine.endSession(s3.id, 'manual');
    assert.strictEqual(endRes.status, 'ended');
    // Active duration must be based strictly on billingStartTime, NOT requestedAt
    assert.strictEqual(
      endRes.elapsedSec,
      Math.max(0, Math.floor((new Date(endRes.endedAt).getTime() - acceptTimestamp) / 1000)),
      '9 & 10. Duration must be calculated from billingStartTime to endedAt, completely excluding pending time'
    );
    pass('Billing duration excludes pending time');
    pass('Ending chat calculates only active duration');

    // 11. Duplicate pending chat prevented
    // Create an active session
    const s4Res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    assert.strictEqual(s4Res.status, 201);
    // Doctor or patient already has pending session -> next start must be rejected
    const dupRes = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    assert.strictEqual(dupRes.status, 409, 'Duplicate consultation must return 409 Conflict');
    pass('Duplicate pending chat prevented');

    // Accept s4 to test messaging
    sessionsCtrl.accept(s4Res.body.id, testDoctor.id);

    // 12. Text message still works
    const chatMsgRes = sessionsCtrl.chat(s4Res.body.id, {
      sender: 'patient',
      message: 'Hello Doctor, I have a skin question.',
    });
    assert.strictEqual(chatMsgRes.status, 200);
    assert.strictEqual(chatMsgRes.body.delivered, true);
    assert.strictEqual(chatMsgRes.body.message.message, 'Hello Doctor, I have a skin question.');
    assert.strictEqual(chatMsgRes.body.message.type, 'text');

    const s4Session = db.sessions.find(s4Res.body.id);
    assert.strictEqual(s4Session.messages.length, 1, 'Message must be stored in session history');
    pass('Text message still works');

    // 13. Image attachment upload works
    const dummyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    const imgReq = {
      headers: {
        authorization: `Bearer ${patientToken}`,
        'content-type': 'application/json',
      },
      body: {
        sessionId: s4Res.body.id,
        fileName: 'skin_rash.png',
        mimeType: 'image/png',
        fileData: dummyPng.toString('base64'),
      },
    };
    const imgRes = await chatUpload.handleUpload(imgReq, null, {});
    assert.strictEqual(imgRes.status, 201);
    assert.strictEqual(imgRes.body.attachment.type, 'image');
    assert.strictEqual(imgRes.body.attachment.mimeType, 'image/png');
    assert.ok(imgRes.body.attachment.url.startsWith('/api/chat/attachment/'));
    const imgAtt = imgRes.body.attachment;

    // Send image chat message
    const sendImgChat = sessionsCtrl.chat(s4Res.body.id, {
      sender: 'patient',
      message: 'Here is the rash image',
      type: 'image',
      attachment: imgAtt,
    });
    assert.strictEqual(sendImgChat.status, 200);
    assert.strictEqual(sendImgChat.body.message.type, 'image');
    pass('Image attachment upload works');

    // 14. Audio attachment upload works
    const dummyWav = Buffer.from('RIFF24_DUMMY_AUDIO_DATA_FOR_TESTING_1234567890');
    const audioReq = {
      headers: {
        authorization: `Bearer ${patientToken}`,
        'content-type': 'application/json',
      },
      body: {
        sessionId: s4Res.body.id,
        fileName: 'voice_note.webm',
        mimeType: 'audio/webm',
        fileData: dummyWav.toString('base64'),
      },
    };
    const audioRes = await chatUpload.handleUpload(audioReq, null, {});
    assert.strictEqual(audioRes.status, 201);
    assert.strictEqual(audioRes.body.attachment.type, 'audio');
    assert.strictEqual(audioRes.body.attachment.mimeType, 'audio/webm');
    pass('Audio attachment upload works');

    // 15. File attachment upload works
    const dummyPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    const docReq = {
      headers: {
        authorization: `Bearer ${patientToken}`,
        'content-type': 'application/json',
      },
      body: {
        sessionId: s4Res.body.id,
        fileName: 'medical_report.pdf',
        mimeType: 'application/pdf',
        fileData: dummyPdf.toString('base64'),
      },
    };
    const docRes = await chatUpload.handleUpload(docReq, null, {});
    assert.strictEqual(docRes.status, 201);
    assert.strictEqual(docRes.body.attachment.type, 'file');
    assert.strictEqual(docRes.body.attachment.mimeType, 'application/pdf');
    const docAtt = docRes.body.attachment;
    pass('File attachment upload works');

    // 16. Unauthorized attachment access rejected
    let servedStatus = null;
    let servedError = null;
    const fakeRes = {
      writeHead(code, headers) {
        servedStatus = code;
      },
      end(body) {
        try {
          servedError = JSON.parse(body);
        } catch (e) {}
      },
    };

    // Unauthenticated request
    chatUpload.serveAttachment(
      { headers: {} },
      fakeRes,
      docAtt.id,
      {},
      () => '*'
    );
    assert.strictEqual(servedStatus, 401, 'Unauthenticated access must return 401');

    // Unauthorized request by stranger
    servedStatus = null;
    chatUpload.serveAttachment(
      { headers: { authorization: `Bearer ${strangerToken}` } },
      fakeRes,
      docAtt.id,
      {},
      () => '*'
    );
    assert.strictEqual(servedStatus, 403, 'Stranger access to another patient\'s consult attachment must return 403');
    pass('Unauthorized attachment access rejected');

    // 17. Invalid file type rejected
    const badReq = {
      headers: {
        authorization: `Bearer ${patientToken}`,
        'content-type': 'application/json',
      },
      body: {
        sessionId: s4Res.body.id,
        fileName: 'virus.exe',
        mimeType: 'application/x-msdownload',
        fileData: Buffer.from('bad executable').toString('base64'),
      },
    };
    const badRes = await chatUpload.handleUpload(badReq, null, {});
    assert.strictEqual(badRes.status, 400, 'Executable file must be rejected with 400');
    assert.ok(badRes.body.error.includes('prohibited'));
    pass('Invalid file type rejected');

    // 18. Oversized file rejected
    const hugeImageBuffer = Buffer.alloc(11 * 1024 * 1024); // 11 MB > 10 MB limit
    const hugeReq = {
      headers: {
        authorization: `Bearer ${patientToken}`,
        'content-type': 'application/json',
      },
      body: {
        sessionId: s4Res.body.id,
        fileName: 'huge.png',
        mimeType: 'image/png',
        fileData: hugeImageBuffer.toString('base64'),
      },
    };
    const hugeRes = await chatUpload.handleUpload(hugeReq, null, {});
    assert.strictEqual(hugeRes.status, 400, 'Oversized image must be rejected with 400');
    assert.ok(hugeRes.body.error.includes('10 MB'));
    pass('Oversized file rejected');

    // 19. Patient receives accept/reject state in real time
    // End s4 so patient and doctor are freed
    sessionsCtrl.end(s4Res.body.id);

    // Create new session to test real-time SSE stream events
    const s5Res = sessionsCtrl.start({
      patientId: testPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    assert.strictEqual(s5Res.status, 201);
    const s5Events = [];
    sse.subscribe(s5Res.body.id, {
      writeHead() {},
      write(chunk) {
        const match = chunk.match(/event:\s*([^\n]+)\ndata:\s*([^\n]+)/);
        if (match) {
          try {
            s5Events.push({ event: match[1], data: JSON.parse(match[2]) });
          } catch (e) {}
        }
      },
      req: { on() {} },
    });

    sessionsCtrl.accept(s5Res.body.id, testDoctor.id);
    const acceptEvt = s5Events.find((e) => e.event === 'call_accepted');
    assert.ok(acceptEvt, 'Patient must receive call_accepted in real time via SSE');
    assert.strictEqual(acceptEvt.data.sessionId, s5Res.body.id);
    assert.strictEqual(acceptEvt.data.session.status, 'active');
    pass('Patient receives accept/reject state in real time');

    // 20. Doctor receives incoming chat in real time
    // End s5 so doctor is freed
    sessionsCtrl.end(s5Res.body.id);

    const s6Res = sessionsCtrl.start({
      patientId: strangerPatient.id,
      doctorId: testDoctor.id,
      type: 'chat',
    });
    assert.strictEqual(s6Res.status, 201);
    const docIncomingChat = doctorNotifications.find(
      (n) => n.event === 'incoming_call' && n.data.sessionId === s6Res.body.id
    );
    assert.ok(docIncomingChat, 'Doctor must receive incoming chat in real time');
    assert.strictEqual(docIncomingChat.data.type, 'chat');
    assert.strictEqual(docIncomingChat.data.patientName, 'Stranger Bob');
    pass('Doctor receives incoming chat in real time');

    // Clean up active session
    billingEngine.endSession(s5Res.body.id);
    sessionsCtrl.end(s6Res.body.id);
    sessionsCtrl.end(s4Res.body.id);

    console.log(`\n🎉 ALL ${testCount} DEDICATED CHAT & BILLING TESTS PASSED!`);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    restoreData();
    console.log('Database files restored to original state.');
    process.exit(process.exitCode || 0);
  }
}

run();
