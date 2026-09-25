// test_account_system.js
// Automated verification for Dexa Consult Account System
// Includes Patient & Doctor Auth, Profile Edit, Logout, and Production Password Reset flows

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Backup patients and doctors JSON before test
const dataDir = path.join(__dirname, 'data');
const patientsBackup = fs.readFileSync(path.join(dataDir, 'patients.json'), 'utf8');
const doctorsBackup = fs.readFileSync(path.join(dataDir, 'doctors.json'), 'utf8');

function restoreData() {
  fs.writeFileSync(path.join(dataDir, 'patients.json'), patientsBackup);
  fs.writeFileSync(path.join(dataDir, 'doctors.json'), doctorsBackup);
}

// Start server on port 4001 to avoid conflicts
process.env.PORT = '4001';
process.env.FRONTEND_URL = 'https://rkhero01.github.io/dexa-consult';
const server = require('./server'); // starts server on PORT 4001
const emailService = require('./emailService');
const db = require('./db');

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      {
        hostname: 'localhost',
        port: 4001,
        path,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: raw ? JSON.parse(raw) : null,
              raw,
            });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting Dexa Consult Account System & Production Password Reset Tests ---\n');

  try {
    // Wait for server to listen
    await new Promise((r) => setTimeout(r, 500));

    // Test 1: Health check & Static File Serving
    console.log('1. Health check & Static File Serving');
    const health = await request('GET', '/api/health');
    assert.strictEqual(health.status, 200, 'Health check should return 200');
    console.log('   ✓ Health check passed');

    const platformRes = await request('GET', '/platform.html');
    assert.strictEqual(platformRes.status, 200, 'GET /platform.html should serve static HTML');
    assert(platformRes.raw.includes('Dexa Consult'), 'platform.html contains Dexa Consult branding');
    assert(platformRes.raw.includes('fResetToken'), 'platform.html contains hidden reset token input');
    console.log('   ✓ Static serving of platform.html verified');

    const indexRes = await request('GET', '/index.html');
    assert.strictEqual(indexRes.status, 200, 'GET /index.html should serve static HTML');
    assert(indexRes.raw.includes('Dexa Consult'), 'index.html contains Dexa Consult branding');
    console.log('   ✓ Static serving of index.html verified');

    const logoRes = await request('GET', '/assets/dexa-clinic-logo.png');
    assert.strictEqual(logoRes.status, 200, 'GET /assets/dexa-clinic-logo.png should return 200');
    assert.strictEqual(logoRes.headers['content-type'], 'image/png');
    console.log('   ✓ Static serving of logo image verified');

    // Test 2: Patient Signup
    console.log('\n2. Patient Signup POST /api/auth/patient/signup');
    const testPatientEmail = `testpatient_${Date.now()}@example.com`;
    const signupRes = await request('POST', '/api/auth/patient/signup', {
      name: 'John Doe',
      email: testPatientEmail,
      phone: '9876543210',
      password: 'SecurePassword123!',
    });
    assert.strictEqual(signupRes.status, 201, 'Signup should return 201');
    assert.strictEqual(signupRes.body.name, 'John Doe');
    assert.strictEqual(signupRes.body.email, testPatientEmail.toLowerCase());
    assert.strictEqual(signupRes.body.passwordHash, undefined, 'passwordHash must not be exposed');
    assert.strictEqual(signupRes.body.passwordSalt, undefined, 'passwordSalt must not be exposed');
    assert.strictEqual(signupRes.body.authToken, undefined, 'authToken must not be exposed');
    assert.strictEqual(signupRes.body.resetPasswordToken, undefined, 'resetPasswordToken must not be exposed');
    console.log('   ✓ Patient signup passed, sensitive fields protected');

    // Test 3: Patient Login
    console.log('\n3. Patient Login POST /api/auth/patient/login');
    const loginRes = await request('POST', '/api/auth/patient/login', {
      email: testPatientEmail.toUpperCase(), // Testing case-insensitive email match
      password: 'SecurePassword123!',
    });
    assert.strictEqual(loginRes.status, 200, 'Login should return 200');
    assert(loginRes.body.token, 'Should receive fresh token');
    const patientToken = loginRes.body.token;
    assert.strictEqual(loginRes.body.patient.name, 'John Doe');
    assert.strictEqual(loginRes.body.patient.passwordHash, undefined);
    assert.strictEqual(loginRes.body.patient.authToken, undefined);
    console.log('   ✓ Patient login successful with fresh token, case-insensitive email verified');

    // Test 4: Patient Profile Loading
    console.log('\n4. Patient Profile GET /api/me/patient');
    const profRes = await request('GET', '/api/me/patient', null, patientToken);
    assert.strictEqual(profRes.status, 200, 'Profile load should return 200');
    assert.strictEqual(profRes.body.name, 'John Doe');
    assert.strictEqual(profRes.body.email, testPatientEmail.toLowerCase());
    assert.strictEqual(profRes.body.phone, '9876543210');
    assert.strictEqual(profRes.body.passwordHash, undefined);
    assert.strictEqual(profRes.body.authToken, undefined);
    console.log('   ✓ Patient profile loaded successfully');

    // Test 5: Patient Edit Profile PATCH /api/me/patient
    console.log('\n5. Patient Edit Profile PATCH /api/me/patient');
    const updatedEmail = `john_updated_${Date.now()}@example.com`;
    const patchRes = await request(
      'PATCH',
      '/api/me/patient',
      {
        name: 'Johnathan Doe',
        email: updatedEmail,
        phone: '9988776655',
      },
      patientToken
    );
    assert.strictEqual(patchRes.status, 200, 'Patch should return 200');
    assert.strictEqual(patchRes.body.name, 'Johnathan Doe');
    assert.strictEqual(patchRes.body.email, updatedEmail.toLowerCase());
    assert.strictEqual(patchRes.body.phone, '9988776655');
    assert.strictEqual(patchRes.body.passwordHash, undefined);
    assert.strictEqual(patchRes.body.authToken, undefined);
    console.log('   ✓ Patient details updated successfully (Name, Email, Phone)');

    // Test 6: Validation & Duplicate Checks on PATCH /api/me/patient
    console.log('\n6. Validation & Duplicate Checks on PATCH /api/me/patient');
    const emptyNameRes = await request('PATCH', '/api/me/patient', { name: '   ' }, patientToken);
    assert.strictEqual(emptyNameRes.status, 400, 'Empty name should return 400');

    const invalidEmailRes = await request('PATCH', '/api/me/patient', { email: 'not-an-email' }, patientToken);
    assert.strictEqual(invalidEmailRes.status, 400, 'Invalid email should return 400');

    const anotherPatientEmail = `another_${Date.now()}@example.com`;
    await request('POST', '/api/auth/patient/signup', {
      name: 'Second Patient',
      email: anotherPatientEmail,
      password: 'Password123!',
    });
    const dupRes = await request('PATCH', '/api/me/patient', { email: anotherPatientEmail }, patientToken);
    assert.strictEqual(dupRes.status, 409, 'Duplicate email should return 409');
    console.log('   ✓ Validations and duplicate email prevention passed');

    // Test 7: Patient Forgot Password POST /api/auth/patient/forgot-password
    console.log('\n7. Patient Forgot Password POST /api/auth/patient/forgot-password');
    emailService.clearLastSentEmail();

    // 7a: Non-existent email should return identical generic 200
    const nonExistentRes = await request('POST', '/api/auth/patient/forgot-password', {
      email: 'nonexistent_account@example.com',
    });
    assert.strictEqual(nonExistentRes.status, 200);
    assert(nonExistentRes.body.message.includes('password reset instructions'));
    assert.strictEqual(nonExistentRes.body.devResetToken, undefined, 'Raw reset token must NEVER be returned in response');
    assert.strictEqual(emailService.getLastSentEmail(), null, 'No email sent for non-existent account');
    console.log('   ✓ Generic 200 returned for non-existent email (security: no email enumeration)');

    // 7b: Existing email request
    const forgotRes = await request('POST', '/api/auth/patient/forgot-password', {
      email: updatedEmail,
    });
    assert.strictEqual(forgotRes.status, 200);
    assert.strictEqual(forgotRes.body.message, nonExistentRes.body.message, 'Generic message identical for existing and non-existing accounts');
    assert.strictEqual(forgotRes.body.devResetToken, undefined, 'Raw token NEVER returned in API response');

    // Verify transactional email was prepared and sent via emailService
    const sentEmail = emailService.getLastSentEmail();
    assert(sentEmail, 'Email service was called to dispatch email');
    assert.strictEqual(sentEmail.to, updatedEmail.toLowerCase());
    assert(sentEmail.resetToken, 'Email contains raw reset token');
    assert.strictEqual(sentEmail.resetToken.length, 64, 'Token is 32 cryptographically secure bytes (64 hex chars)');
    assert(sentEmail.resetLink.includes('https://rkhero01.github.io/dexa-consult/platform.html?resetToken='), 'Reset link uses production GitHub Pages URL');
    assert(sentEmail.resetLink.includes('&role=patient'), 'Reset link includes role=patient');
    console.log('   ✓ Clickable password reset email dispatched with secure production link');

    const rawResetToken = sentEmail.resetToken;

    // Verify DB stores ONLY the SHA-256 hash, NOT the raw token
    const dbPatients = JSON.parse(fs.readFileSync(path.join(dataDir, 'patients.json'), 'utf8'));
    const patientInDb = dbPatients.find((p) => p.email === updatedEmail.toLowerCase());
    assert(patientInDb.resetPasswordToken, 'Hashed token stored in database');
    assert.notStrictEqual(patientInDb.resetPasswordToken, rawResetToken, 'Database MUST NOT store plaintext token');
    
    // Verify SHA-256 hash matches
    const expectedHash = crypto.createHash('sha256').update(rawResetToken).digest('hex');
    assert.strictEqual(patientInDb.resetPasswordToken, expectedHash, 'Database stores exact SHA-256 hash');
    
    // Verify expiry is set 15 minutes ahead
    const expiryDate = new Date(patientInDb.resetPasswordExpires);
    const now = Date.now();
    const diffMinutes = (expiryDate.getTime() - now) / (60 * 1000);
    assert(diffMinutes > 14 && diffMinutes <= 15.5, `Token expiry must be ~15 minutes (got ${diffMinutes.toFixed(1)} mins)`);
    console.log('   ✓ SHA-256 hash stored in DB with 15-minute expiry, raw token never stored in DB');

    // Test 8: Patient Reset Password POST /api/auth/patient/reset-password
    console.log('\n8. Patient Reset Password POST /api/auth/patient/reset-password');
    // 8a: Password too short
    const shortPassRes = await request('POST', '/api/auth/patient/reset-password', {
      token: rawResetToken,
      newPassword: '123',
    });
    assert.strictEqual(shortPassRes.status, 400);
    console.log('   ✓ Short password correctly rejected');

    // 8b: Invalid token rejected
    const invalidTokenRes = await request('POST', '/api/auth/patient/reset-password', {
      token: 'invalid_token_xyz_1234567890abcdef',
      newPassword: 'NewSecurePassword456!',
    });
    assert.strictEqual(invalidTokenRes.status, 400);
    assert(invalidTokenRes.body.error.includes('invalid or has expired'));
    console.log('   ✓ Invalid token cleanly rejected with friendly message');

    // 8c: Expired token rejected
    console.log('\n   Testing expired token rejection...');
    // Artificially expire the token in database
    const patientRecord = db.patients.where((p) => p.email === updatedEmail.toLowerCase())[0];
    db.patients.update(patientRecord.id, {
      resetPasswordExpires: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute in past
    });
    const expiredTokenRes = await request('POST', '/api/auth/patient/reset-password', {
      token: rawResetToken,
      newPassword: 'NewSecurePassword456!',
    });
    assert.strictEqual(expiredTokenRes.status, 400);
    assert(expiredTokenRes.body.error.includes('invalid or has expired'));
    console.log('   ✓ Expired token rejected cleanly');

    // Re-issue a fresh token for successful reset test
    await request('POST', '/api/auth/patient/forgot-password', { email: updatedEmail });
    const freshSentEmail = emailService.getLastSentEmail();
    const freshToken = freshSentEmail.resetToken;

    // 8d: Successful password reset
    const newPassword = 'BrandNewPassword999!';
    const resetRes = await request('POST', '/api/auth/patient/reset-password', {
      token: freshToken,
      newPassword,
    });
    assert.strictEqual(resetRes.status, 200);
    assert(resetRes.body.message.includes('successfully'));
    console.log('   ✓ Password reset succeeded');

    // 8e: Verify single-use token (using again should fail)
    const reuseRes = await request('POST', '/api/auth/patient/reset-password', {
      token: freshToken,
      newPassword: 'AnotherPassword111!',
    });
    assert.strictEqual(reuseRes.status, 400, 'Re-using reset token must fail');
    assert(reuseRes.body.error.includes('invalid or has expired'));
    console.log('   ✓ Reset token is single-use and invalidated immediately');

    // 8f: Verify old password fails
    const oldLogin = await request('POST', '/api/auth/patient/login', {
      email: updatedEmail,
      password: 'SecurePassword123!',
    });
    assert.strictEqual(oldLogin.status, 401, 'Old password must no longer work');
    console.log('   ✓ Old password rejected');

    // 8g: Verify new password logs in successfully
    const newLogin = await request('POST', '/api/auth/patient/login', {
      email: updatedEmail,
      password: newPassword,
    });
    assert.strictEqual(newLogin.status, 200, 'New password must log in successfully');
    assert(newLogin.body.token, 'Received fresh token');
    console.log('   ✓ New password logs in successfully with fresh token');

    // 8h: Verify old session was invalidated
    const oldSessionCheck = await request('GET', '/api/me/patient', null, patientToken);
    assert.strictEqual(oldSessionCheck.status, 401, 'Old session token must be invalidated after password reset');
    console.log('   ✓ Old session authToken invalidated across active sessions');

    // Test 9: Doctor Forgot & Reset Password
    console.log('\n9. Doctor Forgot & Reset Password Flow');
    const testDocEmail = `testdoc_${Date.now()}@example.com`;
    await request('POST', '/api/auth/doctor/signup', {
      name: 'Dr. Sarah Connor',
      email: testDocEmail,
      password: 'OriginalDoctorPass!',
      specialization: 'Dermatologist',
      state: 'Ahmedabad',
      rates: { chat: 25, call: 35, video: 50 },
    });

    emailService.clearLastSentEmail();

    // Request doctor reset
    const docForgot = await request('POST', '/api/auth/doctor/forgot-password', {
      email: testDocEmail,
    });
    assert.strictEqual(docForgot.status, 200);
    assert.strictEqual(docForgot.body.devResetToken, undefined, 'No raw token leaked in doctor response');

    const docEmail = emailService.getLastSentEmail();
    assert(docEmail, 'Doctor reset email prepared');
    assert.strictEqual(docEmail.to, testDocEmail.toLowerCase());
    assert(docEmail.resetLink.includes('&role=doctor'), 'Doctor link includes role=doctor');
    const docResetToken = docEmail.resetToken;

    // Reset doctor password
    const newDocPassword = 'NewDoctorSecret2026!';
    const docReset = await request('POST', '/api/auth/doctor/reset-password', {
      token: docResetToken,
      newPassword: newDocPassword,
    });
    assert.strictEqual(docReset.status, 200);
    console.log('   ✓ Doctor password reset succeeded');

    // Doctor cannot reuse token
    const docReuse = await request('POST', '/api/auth/doctor/reset-password', {
      token: docResetToken,
      newPassword: 'AnotherPassword999!',
    });
    assert.strictEqual(docReuse.status, 400);
    console.log('   ✓ Doctor token cannot be reused');

    // Doctor logs in with new password
    const docLogin = await request('POST', '/api/auth/doctor/login', {
      email: testDocEmail,
      password: newDocPassword,
    });
    assert.strictEqual(docLogin.status, 200);
    assert.strictEqual(docLogin.body.doctor.name, 'Dr. Sarah Connor');
    console.log('   ✓ Doctor logs in with new password');

    console.log('\n======================================================');
    console.log('ALL TESTS PASSED SUCCESSFULLY! ✓✓✓');
    console.log('======================================================');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    // Restore original JSON database files
    restoreData();
    console.log('\nDatabase files restored to original state.');
    process.exit(process.exitCode || 0);
  }
}

runTests();
