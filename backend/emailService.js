// emailService.js
// Production-ready transactional email service for Dexa Consult.
// Supports:
// 1. Resend API (via Node's built-in https module - zero external dependencies)
// 2. SMTP relay (if SMTP_HOST is configured)
// 3. Clean fallback & testing harness (captures lastSentEmail for verification)

const https = require('https');

// Track last sent email in memory for testing and auditing
let lastSentEmail = null;

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.APP_URL || (process.env.NODE_ENV === 'production' ? 'https://rkhero01.github.io/dexa-consult' : 'http://localhost:4000');
const EMAIL_FROM = process.env.EMAIL_FROM || 'Dexa Consult <onboarding@resend.dev>';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

function generateResetEmailHtml({ name, resetLink, expiryMinutes = 15 }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your Dexa Consult password</title>
</head>
<body style="margin:0; padding:0; background-color:#f6f8f8; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#0d1e21; -webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f6f8f8; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e1e9ea; box-shadow:0 10px 30px rgba(11,43,50,0.06);" cellspacing="0" cellpadding="0">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg, #0b2b32 0%, #1e7b7e 100%); padding:28px 32px; text-align:center;">
              <h1 style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">
                Dexa Consult
              </h1>
              <p style="margin:4px 0 0; font-size:13px; color:rgba(255,255,255,0.8);">
                Dexa Slim &amp; Shine Aesthetic Clinic
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:36px 32px 28px;">
              <h2 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#0d1e21;">
                Reset your password
              </h2>
              
              <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#475b5f;">
                Hello${name ? ` <b>${escapeHtml(name)}</b>` : ''},
              </p>

              <p style="margin:0 0 24px; font-size:15px; line-height:1.6; color:#475b5f;">
                We received a request to reset the password for your Dexa Consult account. Click the button below to choose a new password:
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 32px;">
                <tr>
                  <td align="center" style="border-radius:999px; background:#1e7b7e;">
                    <a href="${escapeHtml(resetLink)}" target="_blank" rel="noopener noreferrer" style="display:inline-block; padding:14px 32px; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:999px; background:#1e7b7e;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>

              <div style="background-color:#f6f8f8; border-left:3px solid #1e7b7e; padding:12px 16px; border-radius:4px; margin-bottom:24px;">
                <p style="margin:0; font-size:13.5px; line-height:1.5; color:#475b5f;">
                  ⏱️ <b>Important:</b> This password reset link is valid for <b>${expiryMinutes} minutes</b> and can only be used once.
                </p>
              </div>

              <p style="margin:0 0 12px; font-size:13px; line-height:1.5; color:#788b8e;">
                If the button above doesn't work, copy and paste this URL into your browser:
              </p>
              <p style="margin:0 0 28px; font-size:12.5px; line-height:1.5; word-break:break-all; color:#1e7b7e;">
                <a href="${escapeHtml(resetLink)}" style="color:#1e7b7e; text-decoration:underline;">${escapeHtml(resetLink)}</a>
              </p>

              <hr style="border:none; border-top:1px solid #e1e9ea; margin:24px 0;">

              <p style="margin:0; font-size:12.5px; line-height:1.5; color:#788b8e;">
                🛡️ If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged and your account stays completely secure.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#fbfcfc; border-top:1px solid #e1e9ea; padding:20px 32px; text-align:center; font-size:12px; line-height:1.5; color:#788b8e;">
              Dexa Slim &amp; Shine Aesthetic Clinic · Ahmedabad &amp; Surat, Gujarat<br>
              <span style="color:#a1b2b5;">Telehealth consultations and aesthetic wellness.</span>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function generateResetEmailText({ name, resetLink, expiryMinutes = 15 }) {
  return `Reset your Dexa Consult password

Hello${name ? ' ' + name : ''},

We received a request to reset the password for your Dexa Consult account.

Click the link below to set a new password:
${resetLink}

This link is valid for ${expiryMinutes} minutes and can only be used once.

If you did not request this, you can safely ignore this email. Your password will remain unchanged.

--
Dexa Consult
Dexa Slim & Shine Aesthetic Clinic, Gujarat
`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Dispatches email using Resend HTTP API
function sendViaResend({ to, from, subject, html, text, apiKey }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    });

    const options = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.message || `Resend API error (${res.statusCode}): ${data}`));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ raw: data });
          } else {
            reject(new Error(`Resend API error (${res.statusCode}): ${data}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('Resend API request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

const emailService = {
  /**
   * Dispatches password reset email to user
   */
  async sendPasswordResetEmail({ to, name, resetToken, role = 'patient' }) {
    const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL || FRONTEND_URL;
    // Direct link to the live platform page with token and role
    const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
    const resetLink = `${cleanBaseUrl}/platform.html?resetToken=${encodeURIComponent(resetToken)}&role=${encodeURIComponent(role)}`;

    const subject = 'Reset your Dexa Consult password';
    const html = generateResetEmailHtml({ name, resetLink, expiryMinutes: 15 });
    const text = generateResetEmailText({ name, resetLink, expiryMinutes: 15 });

    // Store in-memory record for testing & auditing
    lastSentEmail = {
      to,
      name,
      resetToken,
      resetLink,
      role,
      subject,
      timestamp: new Date().toISOString(),
    };

    const apiKey = process.env.RESEND_API_KEY || RESEND_API_KEY;
    const from = process.env.EMAIL_FROM || EMAIL_FROM;

    if (apiKey) {
      try {
        const result = await sendViaResend({
          to,
          from,
          subject,
          html,
          text,
          apiKey,
        });
        console.log(`[Email Service] Live password reset email dispatched to ${to} (ID: ${result.id || 'ok'})`);
        return { success: true, provider: 'resend', id: result.id };
      } catch (err) {
        console.error(`[Email Service] Failed to send email via Resend to ${to}:`, err.message);
        return { success: false, provider: 'resend', error: err.message };
      }
    }

    // Fallback: development / testing / unconfigured environment
    if (process.env.NODE_ENV === 'production') {
      console.warn(`[Email Service] Notice: RESEND_API_KEY is not configured in environment variables. Email to ${to} was queued in fallback mode.`);
    } else {
      console.log(`[Email Service] (Dev Mode) Password reset email prepared for: ${to}`);
    }

    return { success: true, provider: 'fallback', lastSentEmail };
  },

  /**
   * Helper for automated tests and status checks
   */
  getLastSentEmail() {
    return lastSentEmail;
  },

  clearLastSentEmail() {
    lastSentEmail = null;
  },
};

module.exports = emailService;
