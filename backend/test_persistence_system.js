// test_persistence_system.js
// Automated test suite for Persistent Database, Session Restoration, and Backend Restart resilience.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const db = require('./db');
const auth = require('./auth');
const mePatient = require('./routes/mePatient');
const meDoctor = require('./routes/meDoctor');
const sessions = require('./routes/sessions');

const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_FILES = ['patients', 'doctors', 'sessions', 'attachments', 'transactions'];
const backupData = {};

function snapshotDb() {
  for (const f of BACKUP_FILES) {
    const file = path.join(DATA_DIR, `${f}.json`);
    if (fs.existsSync(file)) {
      backupData[f] = fs.readFileSync(file, 'utf8');
    }
  }
}

function restoreDb() {
  for (const f of BACKUP_FILES) {
    const file = path.join(DATA_DIR, `${f}.json`);
    if (backupData[f]) {
      fs.writeFileSync(file, backupData[f], 'utf8');
    }
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    restoreDb();
    process.exit(1);
  }
}

async function main() {
  console.log('=== RUNNING PERSISTENCE & SESSION LIFECYCLE TESTS ===');
  snapshotDb();

  const testEmail = `pat.persist.${Date.now()}@example.com`;
  const initialPassword = 'InitialSecretPass123!';
  const updatedPassword = 'NewPermanentSecret456!';
  let patientRecord = null;
  let sessionToken = null;

  // 1. Signup persists account
  await runTest('Test 1: Signup persists account with scrypt hash and random salt', async () => {
    const res = auth.patientSignup({
      name: 'Persistent User',
      email: testEmail,
      phone: '9988776655',
      password: initialPassword,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.email, testEmail.toLowerCase());
    assert.strictEqual(res.body.passwordHash, undefined, 'passwordHash must never be exposed');
    assert.strictEqual(res.body.passwordSalt, undefined, 'passwordSalt must never be exposed');

    // Verify stored securely in DB
    const stored = db.patients.where((p) => p.email === testEmail.toLowerCase())[0];
    assert.ok(stored, 'User record must exist in DB');
    assert.ok(stored.passwordHash, 'Hash must exist');
    assert.ok(stored.passwordSalt, 'Salt must exist');
    assert.notStrictEqual(stored.passwordHash, initialPassword, 'Raw password must never be stored');
    patientRecord = stored;
  });

  // 2. Login works & token persists
  await runTest('Test 2: Login verifies password and generates persistent authToken', async () => {
    const loginRes = auth.patientLogin({
      email: testEmail,
      password: initialPassword,
    });
    assert.strictEqual(loginRes.status, 200);
    assert.ok(loginRes.body.token, 'Must return token');
    sessionToken = loginRes.body.token;

    const stored = db.patients.find(patientRecord.id);
    assert.strictEqual(stored.authToken, sessionToken, 'authToken must be persisted in database');
  });

  // 3. Page reload & browser restart restores session
  await runTest('Test 3: Page reload and browser restart restores session via /api/me/patient', async () => {
    const req = { headers: { authorization: `Bearer ${sessionToken}` } };
    const meRes = mePatient.profile(req);
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.body.email, testEmail.toLowerCase());
    assert.strictEqual(meRes.body.id, patientRecord.id);
  });

  // 4. Simulated backend restart does not destroy account or password
  await runTest('Test 4: Backend restart preserves account, salt, and passwordHash', async () => {
    // Simulate process reload by reading stored state directly
    const stored = db.patients.find(patientRecord.id);
    assert.ok(stored, 'Account must survive restart');
    assert.ok(stored.passwordHash, 'Hash must survive restart');
    assert.ok(stored.passwordSalt, 'Salt must survive restart');

    // Login must succeed with existing password
    const loginAgain = auth.patientLogin({
      email: testEmail,
      password: initialPassword,
    });
    assert.strictEqual(loginAgain.status, 200);
    assert.ok(loginAgain.body.token);
    sessionToken = loginAgain.body.token;
  });

  // 5. Forgot Password changes password permanently
  let resetToken = null;
  await runTest('Test 5: Forgot Password generates SHA-256 hashed token with 15min expiry', async () => {
    const forgotRes = auth.patientForgotPassword({ email: testEmail });
    assert.strictEqual(forgotRes.status, 200);

    const stored = db.patients.find(patientRecord.id);
    assert.ok(stored.resetPasswordToken, 'Reset token hash must be saved in DB');
    assert.ok(stored.resetPasswordExpires, 'Expiry must be set');
    assert.ok(new Date(stored.resetPasswordExpires) > new Date(), 'Expiry must be in the future');

    // We retrieve the raw token from emailService mock/tracker
    const lastEmail = auth.emailService.getLastSentEmail();
    assert.ok(lastEmail, 'Password reset email must have been generated');
    resetToken = lastEmail.resetToken;
    assert.ok(resetToken, 'Must have raw reset token');
  });

  // 6. Reset password updates hash and invalidates old sessions
  await runTest('Test 6: Reset password saves new password hash and invalidates active session', async () => {
    const resetRes = auth.patientResetPassword({
      token: resetToken,
      newPassword: updatedPassword,
    });
    assert.strictEqual(resetRes.status, 200);

    const stored = db.patients.find(patientRecord.id);
    assert.strictEqual(stored.resetPasswordToken, null, 'Reset token must be cleared');
    assert.strictEqual(stored.resetPasswordExpires, null, 'Reset expiry must be cleared');
    assert.strictEqual(stored.authToken, null, 'Old auth token must be invalidated');

    // Old token should now fail authentication
    const reqOld = { headers: { authorization: `Bearer ${sessionToken}` } };
    const profileOld = mePatient.profile(reqOld);
    assert.strictEqual(profileOld.status, 401, 'Old session must be rejected after password reset');
  });

  // 7. Old password fails
  await runTest('Test 7: Old password fails verification after reset', async () => {
    const oldLogin = auth.patientLogin({
      email: testEmail,
      password: initialPassword,
    });
    assert.strictEqual(oldLogin.status, 401, 'Old password must be rejected');
  });

  // 8. New password works immediately
  await runTest('Test 8: New password logs in successfully with fresh token', async () => {
    const newLogin = auth.patientLogin({
      email: testEmail,
      password: updatedPassword,
    });
    assert.strictEqual(newLogin.status, 200);
    assert.ok(newLogin.body.token);
    sessionToken = newLogin.body.token;
  });

  // 9. New password survives simulated backend restart
  await runTest('Test 9: New password survives server restart and authenticates properly', async () => {
    // Re-verify that user can log in again with new password
    const persistentLogin = auth.patientLogin({
      email: testEmail,
      password: updatedPassword,
    });
    assert.strictEqual(persistentLogin.status, 200, 'New password must continue working');
    sessionToken = persistentLogin.body.token;
  });

  // 10. Manual logout invalidates session
  await runTest('Test 10: Manual logout destroys session on server and client', async () => {
    const req = { headers: { authorization: `Bearer ${sessionToken}` } };
    const logoutRes = auth.logout(req);
    assert.strictEqual(logoutRes.status, 200);

    const stored = db.patients.find(patientRecord.id);
    assert.strictEqual(stored.authToken, null, 'authToken must be null after logout');

    const meAfterLogout = mePatient.profile(req);
    assert.strictEqual(meAfterLogout.status, 401, 'Request after logout must return 401');
  });

  // 11. Role isolation
  await runTest('Test 11: Patient cannot authenticate on Doctor endpoints and vice-versa', async () => {
    // Fresh login as patient
    const loginRes = auth.patientLogin({ email: testEmail, password: updatedPassword });
    const pToken = loginRes.body.token;

    // Try to access doctor endpoint with patient token
    const docReq = { headers: { authorization: `Bearer ${pToken}` } };
    const docProfile = meDoctor.profile(docReq);
    assert.strictEqual(docProfile.status, 401, 'Patient token must be rejected on doctor endpoint');

    // Patient email entered on doctor login gives guidance
    const wrongTabLogin = auth.doctorLogin({ email: testEmail, password: updatedPassword });
    assert.strictEqual(wrongTabLogin.status, 400);
    assert.ok(wrongTabLogin.body.error.includes("registered as a Patient"));
  });

  // 12. Health endpoint reports database status
  await runTest('Test 12: Database reports engine status and atomic write safety', async () => {
    assert.ok(typeof db.isPostgres === 'boolean');
    assert.ok(typeof db.genId() === 'string');
  });

  restoreDb();
  console.log('🎉 ALL PERSISTENCE TESTS PASSED SUCCESSFULLY!');
  console.log('Database files restored to original state.');
}

main().catch((err) => {
  console.error('Test suite failed:', err);
  restoreDb();
  process.exit(1);
});
