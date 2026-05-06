// ═══════════════════════════════════════════════════════
//  emails.js — All transactional email templates
//  Sender: support@affordablerentals.site (via Resend)
//
//  Exports:
//    sendWelcomeEmail({ name, email })
//    sendRentReminder({ name, email, house, rent, month, dueDate, arrears })
//    sendMoveOutEmail({ name, email, house, moveOutDate })
//    sendPasswordResetEmail({ name, email, code })
// ═══════════════════════════════════════════════════════

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Verified custom domain sender ──
const FROM = 'Affordable Rentals 🏠 <support@affordablerentals.site>';

// ── Dashboard URL ──
const DASHBOARD_URL = process.env.BASE_URL || 'http://localhost:3000';

// ── Helper: ordinal suffix (1st, 2nd, 3rd...) ──
function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}

// ═══════════════════════════════════════════════════════
// 1. WELCOME EMAIL
// Call after tenant registers
// ═══════════════════════════════════════════════════════

async function sendWelcomeEmail({ name, email }) {
    const { error } = await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: `Welcome to Affordable Rentals, ${name.split(' ')[0]}! 🎉`,
        html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <!-- Header -->
            <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🏠</div>
              <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;letter-spacing:-0.5px">
                Welcome to Affordable Rentals
              </h1>
              <p style="color:#bae6fd;margin:8px 0 0;font-size:14px">Your home, managed well.</p>
            </div>

            <!-- Body -->
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">
                Hi <strong>${name.split(' ')[0]}</strong> 👋,
              </p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your tenant account has been successfully created on <strong>Affordable Rentals</strong>.
                You can now log in to your dashboard to view your house details,
                make rent payments via M-Pesa, download receipts, and chat with your landlord.
              </p>

              <!-- Info box -->
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">
                  YOUR ACCOUNT
                </p>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:6px 0">Name</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${name}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:6px 0">Email</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${email}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:6px 0">Role</td>
                    <td style="text-align:right">
                      <span style="background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">Tenant</span>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- CTA -->
              <div style="text-align:center;margin-bottom:28px">
                <a href="${DASHBOARD_URL}/tenant.html"
                   style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px;letter-spacing:0.02em">
                  Go to My Dashboard →
                </a>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                If you have any questions, reply to this email or use the chat feature in your dashboard to message your landlord directly.
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">
                © ${new Date().getFullYear()} Affordable Rentals · <a href="https://affordablerentals.site" style="color:#94a3b8;text-decoration:none">affordablerentals.site</a>
              </p>
              <p style="color:#e2e8f0;font-size:10px;margin:6px 0 0">
                You received this because you registered an account.
              </p>
            </div>

          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Welcome email failed: ${error.message}`);
    console.log(`📧 Welcome email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 2. RENT REMINDER EMAIL
// Call from checkArrears() cron job
// ═══════════════════════════════════════════════════════

async function sendRentReminder({ name, email, house, rent, month, dueDate, arrears }) {
    const isOverdue = arrears > 0;

    const { error } = await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: isOverdue
            ? `⚠️ Rent Overdue — ${month} | ${house}`
            : `🔔 Rent Reminder — ${month} | ${house}`,
        html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <!-- Header -->
            <div style="background:${isOverdue ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'linear-gradient(135deg,#d97706,#b45309)'};padding:36px 32px;text-align:center">
              <div style="font-size:44px;margin-bottom:10px">${isOverdue ? '⚠️' : '🔔'}</div>
              <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700">
                ${isOverdue ? 'Rent Overdue' : 'Rent Due Soon'}
              </h1>
              <p style="color:${isOverdue ? '#fca5a5' : '#fde68a'};margin:8px 0 0;font-size:13px">${month}</p>
            </div>

            <!-- Body -->
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">
                Hi <strong>${name.split(' ')[0]}</strong>,
              </p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                ${isOverdue
                    ? `This is a reminder that your rent for <strong>${month}</strong> is <strong style="color:#dc2626">overdue</strong>. Please make your payment as soon as possible to avoid any penalties.`
                    : `This is a friendly reminder that your rent for <strong>${month}</strong> is due on the <strong>${dueDate}${ordinal(dueDate)}</strong>. Please ensure payment is made on time.`
                }
              </p>

              <!-- Details box -->
              <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#92400e;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">
                  PAYMENT DETAILS
                </p>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="color:#78716c;font-size:13px;padding:6px 0">House</td>
                    <td style="color:#1c1917;font-size:13px;font-weight:600;text-align:right">${house}</td>
                  </tr>
                  <tr>
                    <td style="color:#78716c;font-size:13px;padding:6px 0">Month</td>
                    <td style="color:#1c1917;font-size:13px;font-weight:600;text-align:right">${month}</td>
                  </tr>
                  <tr>
                    <td style="color:#78716c;font-size:13px;padding:6px 0">Rent Amount</td>
                    <td style="color:#1c1917;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(rent).toLocaleString()}</td>
                  </tr>
                  ${isOverdue ? `
                  <tr>
                    <td style="color:#dc2626;font-size:13px;padding:6px 0">Amount Owed</td>
                    <td style="color:#dc2626;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(arrears).toLocaleString()}</td>
                  </tr>` : `
                  <tr>
                    <td style="color:#78716c;font-size:13px;padding:6px 0">Due Date</td>
                    <td style="color:#1c1917;font-size:13px;font-weight:600;text-align:right">${dueDate}${ordinal(dueDate)} of ${month}</td>
                  </tr>`}
                </table>
              </div>

              <!-- CTA -->
              <div style="text-align:center;margin-bottom:28px">
                <a href="${DASHBOARD_URL}/tenant.html"
                   style="display:inline-block;background:${isOverdue ? '#dc2626' : '#d97706'};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px">
                  Pay Rent Now →
                </a>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                If you have already made payment, please ignore this email. Contact your landlord via the dashboard chat if you have any concerns.
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">
                © ${new Date().getFullYear()} Affordable Rentals · <a href="https://affordablerentals.site" style="color:#94a3b8;text-decoration:none">affordablerentals.site</a>
              </p>
              <p style="color:#e2e8f0;font-size:10px;margin:6px 0 0">Automated rent reminder.</p>
            </div>

          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Rent reminder failed: ${error.message}`);
    console.log(`📧 Rent reminder sent to ${email} for ${month}`);
}


// ═══════════════════════════════════════════════════════
// 3. MOVE-OUT GOODBYE EMAIL
// Call inside PUT /move-out/:tenantId before clearing house
// ═══════════════════════════════════════════════════════

async function sendMoveOutEmail({ name, email, house, moveOutDate }) {
    const { error } = await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: `Goodbye ${name.split(' ')[0]} — Move-out Confirmed 🏠`,
        html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <!-- Header -->
            <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🚪</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700">
                Goodbye, ${name.split(' ')[0]}
              </h1>
              <p style="color:#94a3b8;margin:8px 0 0;font-size:13px">We hope to see you again someday.</p>
            </div>

            <!-- Body -->
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">
                Hi <strong>${name.split(' ')[0]}</strong>,
              </p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your move-out from <strong>${house}</strong> has been confirmed.
                It has been a pleasure having you as a tenant. We wish you all the best in your new place!
              </p>

              <!-- Summary -->
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">
                  MOVE-OUT SUMMARY
                </p>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:6px 0">Tenant</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${name}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:6px 0">House</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${house}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:6px 0">Move-out Date</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">
                      ${new Date(moveOutDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:6px 0">Status</td>
                    <td style="text-align:right">
                      <span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">
                        Moved Out ✓
                      </span>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- Quote -->
              <div style="background:#eff6ff;border-radius:10px;padding:20px 24px;margin-bottom:28px;text-align:center">
                <p style="color:#1d4ed8;font-size:14px;line-height:1.7;margin:0;font-style:italic">
                  "Thank you for being part of our community.
                   Your receipts and payment history remain accessible
                   via your account should you ever need them."
                </p>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                Your account remains active and you can still access your payment history and receipts.
                If you believe this move-out was processed in error, please contact your landlord immediately
                or email us at <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>.
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">
                © ${new Date().getFullYear()} Affordable Rentals · <a href="https://affordablerentals.site" style="color:#94a3b8;text-decoration:none">affordablerentals.site</a>
              </p>
              <p style="color:#e2e8f0;font-size:10px;margin:6px 0 0">Take care out there 🌟</p>
            </div>

          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Move-out email failed: ${error.message}`);
    console.log(`📧 Move-out email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 4. PASSWORD RESET EMAIL
// Call from POST /forgot-password route
// ═══════════════════════════════════════════════════════

async function sendPasswordResetEmail({ name, email, code }) {
    const { error } = await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: `🔑 Your Password Reset Code — Affordable Rentals`,
        html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <!-- Header -->
            <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🔑</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700">
                Password Reset
              </h1>
              <p style="color:#bae6fd;margin:8px 0 0;font-size:13px">Use the code below to reset your password</p>
            </div>

            <!-- Body -->
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">
                Hi <strong>${name.split(' ')[0]}</strong>,
              </p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 28px">
                We received a request to reset your password. Use the 6-digit code below to proceed.
                This code expires in <strong>15 minutes</strong>.
              </p>

              <!-- OTP Code box -->
              <div style="background:#f0f9ff;border:2px dashed #0ea5e9;border-radius:12px;padding:28px 24px;text-align:center;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 16px;font-weight:600">
                  YOUR RESET CODE
                </p>
                <div style="display:inline-block">
                  <span style="font-family:'Courier New',monospace;font-size:42px;font-weight:900;letter-spacing:12px;color:#1d4ed8;display:block;line-height:1">
                    ${code}
                  </span>
                </div>
                <p style="color:#94a3b8;font-size:12px;margin:16px 0 0">
                  Expires in 15 minutes · Do not share this code
                </p>
              </div>

              <!-- Direct link -->
              <div style="text-align:center;margin-bottom:28px">
                <a href="${DASHBOARD_URL}/forgot-password.html"
                   style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px;letter-spacing:0.02em">
                  Reset My Password →
                </a>
              </div>

              <!-- Security warning -->
              <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                <p style="color:#991b1b;font-size:12px;line-height:1.6;margin:0;font-weight:600">
                  🛡️ Security Notice
                </p>
                <p style="color:#b91c1c;font-size:12px;line-height:1.6;margin:8px 0 0">
                  If you did not request a password reset, please ignore this email. Your account is safe.
                  Never share this code with anyone — Affordable Rentals staff will never ask for it.
                </p>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                Having trouble? Reply to this email or contact us at
                <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">
                © ${new Date().getFullYear()} Affordable Rentals · <a href="https://affordablerentals.site" style="color:#94a3b8;text-decoration:none">affordablerentals.site</a>
              </p>
              <p style="color:#e2e8f0;font-size:10px;margin:6px 0 0">
                You received this because a password reset was requested for your account.
              </p>
            </div>

          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Password reset email failed: ${error.message}`);
    console.log(`📧 Password reset email sent to ${email}`);
}


module.exports = {
    sendWelcomeEmail,
    sendRentReminder,
    sendMoveOutEmail,
    sendPasswordResetEmail
};