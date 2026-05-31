import { createTransport } from 'nodemailer';
import bcrypt from 'bcrypt';
import { User } from '../models/user.model.js';

async function mailSender(email, emailType, otp) {
  let subject, htmlContent;

  switch (emailType) {
    case "FORGOT_PASSWORD":
      subject = "Password Reset OTP";
      htmlContent = `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
          <h2 style="color:#111827;margin-bottom:8px;">Reset your password</h2>
          <p style="color:#6b7280;margin-bottom:24px;">Use the OTP below to reset your password. It expires in <strong>5 minutes</strong>.</p>
          <div style="background:#f3f4f6;border-radius:6px;padding:20px;text-align:center;letter-spacing:8px;font-size:32px;font-weight:700;color:#111827;">
            ${otp}
          </div>
          <p style="color:#9ca3af;font-size:13px;margin-top:24px;">If you didn't request a password reset, please secure your account immediately.</p>
        </div>`;
      break;

    case "VERIFY_EMAIL":
      subject = "Verify Your Email Address",
        htmlContent = `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
          <h2 style="color:#111827;margin-bottom:8px;">Verify your email</h2>
          <p style="color:#6b7280;margin-bottom:24px;">Use the OTP below to verify your email address. It expires in <strong>5 minutes</strong>.</p>
          <div style="background:#f3f4f6;border-radius:6px;padding:20px;text-align:center;letter-spacing:8px;font-size:32px;font-weight:700;color:#111827;">
            ${otp}
          </div>
          <p style="color:#9ca3af;font-size:13px;margin-top:24px;">If you didn't create an account, you can safely ignore this email.</p>
        </div>`;
      break;

    default:
      throw new Error(
        "Invalid email type"
      );
  }

  // Create a Transporter to send emails
  let transporter = createTransport({
    host: process.env.MAIL_HOST,
    port: process.env.EMAIL_PORT,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    }
  });

  // Send emails to users
  let mailResponse = await transporter.sendMail({
    from: process.env.MAIL_USER,
    to: email,
    subject: subject,
    html: htmlContent
  });

  return mailResponse;
};

export default mailSender;