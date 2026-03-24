const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
    if (transporter) return transporter;

    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
        throw new Error('Email service is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.');
    }

    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT),
        secure: String(SMTP_SECURE || 'false').toLowerCase() === 'true',
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        }
    });

    return transporter;
}

async function sendPasswordSetupEmail({ toEmail, fullName, setupLink }) {
    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;
    const mailer = getTransporter();

    await mailer.sendMail({
        from: fromAddress,
        to: toEmail,
        subject: 'EduPay Account Setup - Set Your Password',
        text:
            `Hello ${fullName},\n\n` +
            'Your EduPay teacher account has been created.\n' +
            'Use the secure link below to set your password.\n\n' +
            `${setupLink}\n\n` +
            'This link expires in 24 hours.\n' +
            'If you did not expect this email, contact your school administrator.\n',
        html:
            `<p>Hello ${fullName},</p>` +
            '<p>Your EduPay teacher account has been created.</p>' +
            '<p>Use the secure link below to set your password:</p>' +
            `<p><a href="${setupLink}">Set My Password</a></p>` +
            '<p>This link expires in 24 hours.</p>' +
            '<p>If you did not expect this email, contact your school administrator.</p>'
    });
}

module.exports = { sendPasswordSetupEmail };
