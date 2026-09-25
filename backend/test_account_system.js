// test_account_system.js
// Automated verification for Dexa Consult Account System
// Includes Patient & Doctor Auth, Profile Edit, Logout, and Forgot/Reset Password flows

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

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
const server = require('./server'); // starts server on PORT 4001

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
  console.log('--- Starting Dexa Consult Account System & Password Reset Tests ---\n');

  try {
    // Wait for server to listen
    await new Promise((r) => setTimeout(r, 500));

    // Test 1: Health check
    console.log('1. Health check GET /');
    const health = await request('GET', '/');
    assert.strictEqual(health.status, 200, 'Health check should return 200');
    console.log('   ✓ Health check passed');

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
    // 7a: Non-existent email should return generic 200 (does NOT reveal if email exists)
    const nonExistentRes = await request('POST', '/api/auth/patient/forgot-password', {
      email: 'nonexistent_account@example.com',
    });
    assert.strictEqual(nonExistentRes.status, 200);
    assert(nonExistentRes.body.message.includes('password reset instructions'));
    assert.strictEqual(nonExistentRes.body.devResetToken, undefined, 'No token returned for non-existent user');
    console.log('   ✓ Generic 200 returned for non-existent email (security: no email enumeration)');

    // 7b: Existing email request
    const forgotRes = await request('POST', '/api/auth/patient/forgot-password', {
      email: updatedEmail,
    });
    assert.strictEqual(forgotRes.status, 200);
    assert(forgotRes.body.message.includes('password reset instructions'));
    const rawResetToken = forgotRes.body.devResetToken;
    assert(rawResetToken, 'Dev reset token provided in development mode for test');
    assert.strictEqual(rawResetToken.length, 64, 'Token is 32 cryptographically secure bytes (64 hex characters)');

    // Verify DB stores only the SHA-256 hash, NOT the raw token
    const dbPatients = JSON.parse(fs.readFileSync(path.join(dataDir, 'patients.json'), 'utf8'));
    const patientInDb = dbPatients.find((p) => p.email === updatedEmail.toLowerCase());
    assert(patientInDb.resetPasswordToken, 'Hashed token stored in database');
    assert.notStrictEqual(patientInDb.resetPasswordToken, rawResetToken, 'Database MUST NOT store plaintext token');
    assert(new Date(patientInDb.resetPasswordExpires) > new Date(), 'Expiry set in the future');
    console.log('   ✓ Secure random token generated, hashed with SHA-256, and stored with expiry');

    // Test 8: Patient Reset Password POST /api/auth/patient/reset-password
    console.log('\n8. Patient Reset Password POST /api/auth/patient/reset-password');
    // 8a: Password too short
    const shortPassRes = await request('POST', '/api/auth/patient/reset-password', {
      token: rawResetToken,
      newPassword: '123',
    });
    assert.strictEqual(shortPassRes.status, 400);
    console.log('   ✓ Short password correctly rejected');

    // 8b: Invalid token
    const invalidTokenRes = await request('POST', '/api/auth/patient/reset-password', {
      token: 'fake_invalid_token_123',
      newPassword: 'NewSecurePassword456!',
    });
    assert.strictEqual(invalidTokenRes.status, 400);
    console.log('   ✓ Invalid token correctly rejected');

    // 8c: Successful password reset
    const newPassword = 'BrandNewPassword999!';
    const resetRes = await request('POST', '/api/auth/patient/reset-password', {
      token: rawResetToken,
      newPassword,
    });
    assert.strictEqual(resetRes.status, 200);
    assert(resetRes.body.message.includes('successfully'));
    console.log('   ✓ Password reset succeeded');

    // 8d: Verify single-use token (using again should fail)
    const reuseRes = await request('POST', '/api/auth/patient/reset-password', {
      token: rawResetToken,
      newPassword: 'AnotherPassword111!',
    });
    assert.strictEqual(reuseRes.status, 400, 'Re-using reset token must fail');
    console.log('   ✓ Reset token is single-use and invalidated immediately');

    // 8e: Verify old password fails
    const oldLogin = await request('POST', '/api/auth/patient/login', {
      email: updatedEmail,
      password: 'SecurePassword123!',
    });
    assert.strictEqual(oldLogin.status, 401, 'Old password must no longer work');
    console.log('   ✓ Old password rejected');

    // 8f: Verify new password logs in successfully
    const newLogin = await request('POST', '/api/auth/patient/login', {
      email: updatedEmail,
      password: newPassword,
    });
    assert.strictEqual(newLogin.status, 200, 'New password must log in successfully');
    assert(newLogin.body.token, 'Received fresh token');
    console.log('   ✓ New password logs in successfully with fresh token');

    // 8g: Verify old session was invalidated
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

    // Request doctor reset
    const docForgot = await request('POST', '/api/auth/doctor/forgot-password', {
      email: testDocEmail,
    });
    assert.strictEqual(docForgot.status, 200);
    const docResetToken = docForgot.body.devResetToken;
    assert(docResetToken, 'Received doctor dev reset token');

    // Reset doctor password
    const newDocPassword = 'NewDoctorSecret2026!';
    const docReset = await request('POST', '/api/auth/doctor/reset-password', {
      token: docResetToken,
      newPassword: newDocPassword,
    });
    assert.strictEqual(docReset.status, 200);

    // Doctor logs in with new password
    const docLogin = await request('POST', '/api/auth/doctor/login', {
      email: testDocEmail,
      password: newDocPassword,
    });
    assert.strictEqual(docLogin.status, 200);
    assert.strictEqual(docLogin.body.doctor.name, 'Dr. Sarah Connor');
    console.log('   ✓ Doctor forgot-password and reset-password work seamlessly');

    // Test 10: Production mode security check
    console.log('\n10. Production Mode Security Check');
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const prodForgotRes = await request('POST', '/api/auth/patient/forgot-password', {
      email: updatedEmail,
    });
    assert.strictEqual(prodForgotRes.status, 200);
    assert.strictEqual(
      prodForgotRes.body.devResetToken,
      undefined,
      'devResetToken must NEVER be returned in production mode'
    );
    process.env.NODE_ENV = originalEnv;
    console.log('   ✓ In production mode, reset token is never exposed in API responses');

    console.log('\n==========================================');
    console.log('ALL TESTS PASSED SUCCESSFULLY! ✓✓✓');
    console.log('==========================================');
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
