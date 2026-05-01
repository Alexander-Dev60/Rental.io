// ═══════════════════════════════════════════════════════
//  emails.js — All transactional email templates
//  Require this in server.js:
//  const { sendWelcomeEmail, sendRentReminder, sendMoveOutEmail } = require('./emails');
// ═══════════════════════════════════════════════════════

const nodemailer = require('nodemailer');

// REPLACE this:
function getTransporter() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
        }
    });
}

// WITH this:
/*function getTransporter() {
    return nodemailer.createTransport({
        host:   'smtp.gmail.com',
        port:   587,
        secure: false,        // false = TLS (STARTTLS), not SSL
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
        },
        tls: {
            rejectUnauthorized: false  // helps on strict networks
        }
    });
}*/

// ════════════════════════════════════════════════
// 1. WELCOME EMAIL
// Call after tenant registers
// ════════════════════════════════════════════════

async function sendWelcomeEmail({ name, email }) {
    const transporter = getTransporter();

    await transporter.sendMail({
        from:    `RentPortal 🏠 <${process.env.GMAIL_USER}>`,
        to:      email,
        subject: `Welcome to RentPortal, ${name.split(' ')[0]}! 🎉`,
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
            <div style="background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🏠</div>
              <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;letter-spacing:-0.5px">
                Welcome to RentPortal
              </h1>
              <p style="color:#c4b5fd;margin:8px 0 0;font-size:14px">Your home, managed well.</p>
            </div>

            <!-- Body -->
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">
                Hi <strong>${name.split(' ')[0]}</strong> 👋,
              </p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your account has been successfully created on <strong>RentPortal</strong>.
                You can now log in to your tenant dashboard to view your house details,
                make rent payments, download receipts, and chat with your landlord.
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
                      <span style="background:#ede9fe;color:#7c3aed;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">Tenant</span>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- CTA -->
              <div style="text-align:center;margin-bottom:28px">
                <a href="${process.env.APP_URL || 'http://localhost:3000'}/tenant.html"
                   style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px;letter-spacing:0.02em">
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
                © ${new Date().getFullYear()} RentPortal · You received this because you registered an account.
              </p>
            </div>

          </div>
        </body>
        </html>`
    });

    console.log(`📧 Welcome email sent to ${email}`);
}


// ════════════════════════════════════════════════
// 2. RENT REMINDER EMAIL
// Call from checkArrears() cron job
// ════════════════════════════════════════════════

async function sendRentReminder({ name, email, house, rent, month, dueDate, arrears }) {
    const transporter = getTransporter();

    const isOverdue = arrears > 0;

    await transporter.sendMail({
        from:    `RentPortal 🏠 <${process.env.GMAIL_USER}>`,
        to:      email,
        subject: isOverdue
            ? `⚠️ Rent Overdue — ${month} | ${house}`
            : `🔔 Rent Reminder — ${month} | ${house}`,
        html: `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <!-- Header -->
            <div style="background:${isOverdue ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'linear-gradient(135deg,#d97706,#b45309)'};padding:36px 32px;text-align:center">
              <div style="font-size:44px;margin-bottom:10px">${isOverdue ? '⚠️' : '🔔'}</div>
              <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700">
                ${isOverdue ? 'Rent Overdue' : 'Rent Due Soon'}
              </h1>
              <p style="color:${isOverdue ? '#fca5a5' : '#fde68a'};margin:8px 0 0;font-size:13px">
                ${month}
              </p>
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

              <!-- Rent details box -->
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
                <a href="${process.env.APP_URL || 'http://localhost:3000'}/tenant.html"
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
                © ${new Date().getFullYear()} RentPortal · Automated rent reminder.
              </p>
            </div>

          </div>
        </body>
        </html>`
    });

    console.log(`📧 Rent reminder sent to ${email} for ${month}`);
}


// ════════════════════════════════════════════════
// 3. MOVE-OUT GOODBYE EMAIL
// Call inside PUT /move-out/:tenantId before clearing house
// ════════════════════════════════════════════════

async function sendMoveOutEmail({ name, email, house, moveOutDate }) {
    const transporter = getTransporter();

    await transporter.sendMail({
        from:    `RentPortal 🏠 <${process.env.GMAIL_USER}>`,
        to:      email,
        subject: `Goodbye ${name.split(' ')[0]} — Move-out Confirmed 🏠`,
        html: `
        <!DOCTYPE html>
        <html>
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

              <!-- Move-out summary -->
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
                      ${new Date(moveOutDate).toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'})}
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

              <!-- Message -->
              <div style="background:#ede9fe;border-radius:10px;padding:20px 24px;margin-bottom:28px;text-align:center">
                <p style="color:#5b21b6;font-size:14px;line-height:1.7;margin:0;font-style:italic">
                  "Thank you for being part of our community. 
                   Your receipts and payment history remain accessible 
                   via your account should you ever need them."
                </p>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                Your account remains active and you can still access your payment history and receipts. 
                If you believe this move-out was processed in error, please contact your landlord immediately.
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">
                © ${new Date().getFullYear()} RentPortal · Take care out there 🌟
              </p>
            </div>

          </div>
        </body>
        </html>`
    });

    console.log(`📧 Move-out email sent to ${email}`);
}


// ── Helper: ordinal suffix (1st, 2nd, 3rd...) ──
function ordinal(n) {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}


module.exports = { sendWelcomeEmail, sendRentReminder, sendMoveOutEmail };