// auth.js
// Self-serve signup/login for doctors and patients. Passwords hashed with
// Node's built-in scrypt (no bcrypt package needed — zero dependencies).
// A logged-in user gets a bearer token stored on their own record; requests
// to /api/me/* endpoints pass it as `Authorization: Bearer <token>`.

const crypto = require('crypto');
const db = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  try {
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    const bCheck = Buffer.from(check);
    const bHash = Buffer.from(hash);
    if (bCheck.length !== bHash.length) return false;
    return crypto.timingSafeEqual(bCheck, bHash);
  } catch (e) {
    return false;
  }
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- Doctor ----------
function doctorSignup(body) {
  const { name, password, state, rates } = body || {};
  const email = (body && body.email ? String(body.email) : '').trim().toLowerCase();
  if (!name || !email || !password) {
    return { status: 400, body: { error: 'name, email and password are required' } };
  }
  if (db.doctors.where((d) => d.email && d.email.toLowerCase() === email).length) {
    return { status: 409, body: { error: 'An account with this email already exists' } };
  }
  const { salt, hash } = hashPassword(password);
  const doctor = db.doctors.insert({
    name: name.trim(),
    email,
    passwordSalt: salt,
    passwordHash: hash,
    state: state || 'Unassigned',
    specialization: body.specialization || 'General',
    rates: {
      chat: Number(rates?.chat) || 0,
      call: Number(rates?.call) || 0,
      video: Number(rates?.video) || 0,
    },
    status: 'offline',
    authToken: null,
  });
  return { status: 201, body: safeDoctor(doctor) };
}

function doctorLogin(body) {
  const email = (body && body.email ? String(body.email) : '').trim().toLowerCase();
  const password = body && body.password ? String(body.password) : '';
  if (!email || !password) {
    return { status: 400, body: { error: 'Email and password are required' } };
  }
  const doctor = db.doctors.where((d) => d.email && d.email.toLowerCase() === email)[0];
  if (!doctor) {
    const asPatient = db.patients.where((p) => p.email && p.email.toLowerCase() === email)[0];
    if (asPatient && verifyPassword(password, asPatient.passwordSalt, asPatient.passwordHash)) {
      return { status: 400, body: { error: "This email is registered as a Patient. Please select 'I\\'m a Patient' above to log in." } };
    }
    return { status: 401, body: { error: 'Invalid email or password' } };
  }
  if (!verifyPassword(password, doctor.passwordSalt, doctor.passwordHash)) {
    return { status: 401, body: { error: 'Invalid email or password' } };
  }
  const token = genToken();
  const updated = db.doctors.update(doctor.id, { authToken: token });
  return { status: 200, body: { token, doctor: safeDoctor(updated) } };
}

// ---------- Patient ----------
function patientSignup(body) {
  const { name, phone, password } = body || {};
  const email = (body && body.email ? String(body.email) : '').trim().toLowerCase();
  if (!name || !email || !password) {
    return { status: 400, body: { error: 'name, email and password are required' } };
  }
  if (db.patients.where((p) => p.email && p.email.toLowerCase() === email).length) {
    return { status: 409, body: { error: 'An account with this email already exists' } };
  }
  const { salt, hash } = hashPassword(password);
  const patient = db.patients.insert({
    name: name.trim(),
    email,
    phone: phone ? String(phone).trim() : '',
    passwordSalt: salt,
    passwordHash: hash,
    walletBalance: 0,
    authToken: null,
  });
  return { status: 201, body: safePatient(patient) };
}

function patientLogin(body) {
  const email = (body && body.email ? String(body.email) : '').trim().toLowerCase();
  const password = body && body.password ? String(body.password) : '';
  if (!email || !password) {
    return { status: 400, body: { error: 'Email and password are required' } };
  }
  const patient = db.patients.where((p) => p.email && p.email.toLowerCase() === email)[0];
  if (!patient) {
    const asDoctor = db.doctors.where((d) => d.email && d.email.toLowerCase() === email)[0];
    if (asDoctor && verifyPassword(password, asDoctor.passwordSalt, asDoctor.passwordHash)) {
      return { status: 400, body: { error: "This email is registered as a Doctor. Please select 'I\\'m a Doctor' above to log in." } };
    }
    return { status: 401, body: { error: 'Invalid email or password' } };
  }
  if (!verifyPassword(password, patient.passwordSalt, patient.passwordHash)) {
    return { status: 401, body: { error: 'Invalid email or password' } };
  }
  const token = genToken();
  const updated = db.patients.update(patient.id, { authToken: token });
  return { status: 200, body: { token, patient: safePatient(updated) } };
}

// ---------- Request authentication ----------
function getBearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

function authenticateDoctor(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  return db.doctors.where((d) => d.authToken === token)[0] || null;
}

function authenticatePatient(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  return db.patients.where((p) => p.authToken === token)[0] || null;
}

// Strip sensitive fields before sending a record back to the client.
function safeDoctor(d) {
  const { passwordHash, passwordSalt, authToken, resetPasswordToken, resetPasswordExpires, ...rest } = d;
  return rest;
}
function safePatient(p) {
  const { passwordHash, passwordSalt, authToken, resetPasswordToken, resetPasswordExpires, ...rest } = p;
  return rest;
}

// Require external production emailService
const emailService = require('./emailService');

// ============================================================================
// PASSWORD RESET ARCHITECTURE
// ============================================================================
function forgotPassword(collection, body) {
  const email = (body && body.email ? String(body.email) : '').trim().toLowerCase();
  const genericResponse = {
    status: 200,
    body: {
      message: 'If an account exists with this email, password reset instructions have been sent to your email.',
    },
  };

  if (!email) {
    return { status: 400, body: { error: 'Email address is required' } };
  }

  const user = db[collection].where((u) => u.email && u.email.toLowerCase() === email)[0];
  if (!user) {
    // Security: Do NOT reveal whether an email exists
    return genericResponse;
  }

  // Cryptographically secure random token (32 bytes = 64 hex characters)
  const rawToken = crypto.randomBytes(32).toString('hex');
  // Store only the SHA-256 hash in database
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  // 15 minutes expiry
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db[collection].update(user.id, {
    resetPasswordToken: hashedToken,
    resetPasswordExpires: expires,
  });

  const role = collection === 'doctors' ? 'doctor' : 'patient';

  // Call production email notification service to send clickable reset link
  emailService.sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    resetToken: rawToken,
    role,
  });

  // Always return identical generic success response; never leak raw token in API response
  return genericResponse;
}

function resetPassword(collection, body) {
  const { token, newPassword } = body || {};
  const cleanToken = token ? String(token).trim() : '';

  if (!cleanToken) {
    return { status: 400, body: { error: 'Password reset token is required' } };
  }

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return { status: 400, body: { error: 'New password must be at least 6 characters long' } };
  }

  const hashedToken = crypto.createHash('sha256').update(cleanToken).digest('hex');
  const user = db[collection].where((u) => u.resetPasswordToken === hashedToken)[0];

  if (!user || !user.resetPasswordExpires || new Date(user.resetPasswordExpires) < new Date()) {
    return { status: 400, body: { error: 'This password reset link is invalid or has expired. Please request a new one.' } };
  }

  const { salt, hash } = hashPassword(newPassword);
  db[collection].update(user.id, {
    passwordSalt: salt,
    passwordHash: hash,
    resetPasswordToken: null,
    resetPasswordExpires: null,
    authToken: null, // Invalidate active session so old sessions cannot remain authenticated
  });

  return {
    status: 200,
    body: { message: 'Password has been reset successfully. Please log in with your new password.' },
  };
}

function patientForgotPassword(body) {
  return forgotPassword('patients', body);
}
function patientResetPassword(body) {
  return resetPassword('patients', body);
}
function doctorForgotPassword(body) {
  return forgotPassword('doctors', body);
}
function doctorResetPassword(body) {
  return resetPassword('doctors', body);
}

// ============================================================================
// OTP AUTHENTICATION HOOKS (Architecture for Real SMS Provider Integration)
// ============================================================================
const otpService = {
  async sendOtp(phone) {
    throw new Error('Real SMS provider not configured yet. Please log in using email & password.');
  },
  async verifyOtp(phone, code) {
    throw new Error('Real SMS provider not configured yet. Please log in using email & password.');
  },
};

function logout(req) {
  const token = getBearerToken(req);
  if (token) {
    const patient = db.patients.where((p) => p.authToken === token)[0];
    if (patient) {
      db.patients.update(patient.id, { authToken: null });
    }
    const doctor = db.doctors.where((d) => d.authToken === token)[0];
    if (doctor) {
      db.doctors.update(doctor.id, { authToken: null });
    }
  }
  return { status: 200, body: { message: 'Logged out successfully' } };
}

module.exports = {
  doctorSignup,
  doctorLogin,
  doctorForgotPassword,
  doctorResetPassword,
  patientSignup,
  patientLogin,
  patientForgotPassword,
  patientResetPassword,
  logout,
  authenticateDoctor,
  authenticatePatient,
  safeDoctor,
  safePatient,
  otpService,
  emailService,
};

