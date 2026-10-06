const nodemailer = require('nodemailer');
const brand = require('./brand');

let transporter;
let configWarningIssued = false;

function isConfigured() {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

function getTransporter() {
    if (transporter) return transporter;
    if (!isConfigured()) {
        throw new Error('Email service is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.');
    }

    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    return transporter;
}

function fromAddress() {
    return process.env.EMAIL_FROM || process.env.SMTP_USER;
}

/** Minimal HTML escaping so a name containing markup cannot break the email body. */
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function layout(title, bodyHtml) {
    return `<!doctype html><html><body style="margin:0;padding:24px;background:${brand.canvas};font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${brand.text};">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ${brand.rule};">
    <div style="background:${brand.brand};padding:20px 24px;">
      <span style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-.2px;">EduPay</span>
      <div style="color:${brand.PRIMARY[200]};font-size:12px;margin-top:2px;">${esc(title)}</div>
    </div>
    <div style="padding:24px;font-size:14px;line-height:1.6;">${bodyHtml}</div>
    <div style="padding:16px 24px;border-top:1px solid ${brand.INK[100]};color:${brand.textMuted};font-size:11px;">
      This is an automated message from the EduPay payroll system. Please do not reply.
    </div>
  </div>
</body></html>`;
}

async function send({ to, subject, text, html }) {
    const mailer = getTransporter();
    await mailer.sendMail({ from: fromAddress(), to, subject, text, html });
}

async function sendPasswordSetupEmail({ toEmail, fullName, setupLink, expiryHours = 24 }) {
    await send({
        to: toEmail,
        subject: 'EduPay Account Setup - Set Your Password',
        text: `Hello ${fullName},\n\nYour EduPay account has been created.\n`
            + `Use the secure link below to set your password:\n\n${setupLink}\n\n`
            + `This link expires in ${expiryHours} hours.\n`
            + 'If you did not expect this email, contact your school administrator.\n',
        html: layout('Account setup', `
      <p>Hello ${esc(fullName)},</p>
      <p>Your EduPay account has been created. Choose a password to activate it.</p>
      <p style="margin:24px 0;"><a href="${esc(setupLink)}" style="background:${brand.brand};color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;display:inline-block;font-weight:600;">Set my password</a></p>
      <p style="color:${brand.textMuted};font-size:12px;">This link expires in ${expiryHours} hours and can be used once.
      If the button does not work, paste this address into your browser:<br>
      <span style="word-break:break-all;">${esc(setupLink)}</span></p>
      <p style="color:${brand.textMuted};font-size:12px;">If you did not expect this email, contact your school administrator.</p>`)
    });
}

async function sendPasswordResetEmail({ toEmail, fullName, resetLink, expiryMinutes = 60 }) {
    await send({
        to: toEmail,
        subject: 'EduPay Password Reset',
        text: `Hello ${fullName},\n\nA password reset was requested for your EduPay account.\n`
            + `Use the link below to choose a new password:\n\n${resetLink}\n\n`
            + `This link expires in ${expiryMinutes} minutes.\n`
            + 'If you did not request this, you can ignore this email.\n',
        html: layout('Password reset', `
      <p>Hello ${esc(fullName)},</p>
      <p>A password reset was requested for your EduPay account.</p>
      <p style="margin:24px 0;"><a href="${esc(resetLink)}" style="background:${brand.brand};color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;display:inline-block;font-weight:600;">Choose a new password</a></p>
      <p style="color:${brand.textMuted};font-size:12px;">This link expires in ${expiryMinutes} minutes and can be used once.</p>
      <p style="color:${brand.textMuted};font-size:12px;">If you did not request this, no action is needed — your password has not changed.</p>`)
    });
}

async function sendMfaOtpEmail({ toEmail, fullName, otpCode, expiryMinutes = 10 }) {
    await send({
        to: toEmail,
        subject: 'EduPay Login Verification Code',
        text: `Hello ${fullName},\n\nYour EduPay verification code is: ${otpCode}\n\n`
            + `This code expires in ${expiryMinutes} minutes.\n`
            + 'If you did not try to sign in, change your password and contact your administrator.\n',
        html: layout('Login verification', `
      <p>Hello ${esc(fullName)},</p>
      <p>Use this code to finish signing in:</p>
      <p style="margin:20px 0;font-size:30px;font-weight:700;letter-spacing:7px;color:${brand.brandDeep};">${esc(otpCode)}</p>
      <p style="color:${brand.textMuted};font-size:12px;">This code expires in ${expiryMinutes} minutes.</p>
      <p style="color:${brand.textMuted};font-size:12px;">If you did not try to sign in, change your password and contact your administrator immediately.</p>`)
    });
}

async function sendTemporaryCredentialsEmail({ toEmail, fullName, username, temporaryPassword, loginUrl }) {
    await send({
        to: toEmail,
        subject: 'EduPay Account Created',
        text: `Hello ${fullName},\n\nAn EduPay account has been created for you.\n\n`
            + `Username: ${username}\nTemporary password: ${temporaryPassword}\n\n`
            + `Sign in at ${loginUrl} — you will be asked to choose a new password immediately.\n`,
        html: layout('Account created', `
      <p>Hello ${esc(fullName)},</p>
      <p>An EduPay account has been created for you.</p>
      <table style="margin:16px 0;font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:4px 16px 4px 0;color:${brand.textMuted};">Username</td><td style="font-weight:600;">${esc(username)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:${brand.textMuted};">Temporary password</td><td style="font-weight:600;font-family:monospace;">${esc(temporaryPassword)}</td></tr>
      </table>
      <p><a href="${esc(loginUrl)}" style="background:${brand.brand};color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;display:inline-block;font-weight:600;">Sign in</a></p>
      <p style="color:${brand.textMuted};font-size:12px;">You will be asked to choose a new password the first time you sign in.</p>`)
    });
}

module.exports = {
    isConfigured,
    sendPasswordSetupEmail,
    sendPasswordResetEmail,
    sendMfaOtpEmail,
    sendTemporaryCredentialsEmail
};
