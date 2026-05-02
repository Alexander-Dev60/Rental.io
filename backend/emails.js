// ═══════════════════════════════════════════════════════
//  emails.js — All transactional email templates
//  Require this in server.js:
//  const { sendWelcomeEmail, sendRentReminder, sendMoveOutEmail } = require('./emails');
// ═══════════════════════════════════════════════════════

const axios = require('axios'); // already installed in your project

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FROM = { name: 'RentPortal 🏠', email: 'alexanderbosire60@gmail.com' };

// ── Core send function ──
async function sendEmail({ to, subject, html }) {
    await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
            sender:      FROM,
            to:          [{ email: to }],
            subject,
            htmlContent: html
        },
        {
            headers: {
                'api-key':      BREVO_API_KEY,
                'Content-Type': 'application/json'
            }
        }
    );
}

// ════════════════════════════════════════════════
// 1. WELCOME EMAIL
// ════════════════════════════════════════════════

async function sendWelcomeEmail({ name, email }) {
    await sendEmail({
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
            <div style="background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🏠</div>
              <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700">Welcome to RentPortal</h1>
              <p style="color:#c4b5fd;margin:8px 0 0;font-size:14px">Your home, managed well.</p>
            </div>
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${name.split(' ')[0]}</strong> 👋,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your account has been successfully created on <strong>RentPortal</strong>.
                You can now log in to view your house details, make rent payments, download receipts, and chat with your landlord.
              </p>
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
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
              <div style="text-align:center;margin-bottom:28px">
                <a href="${process.env.BASE_URL || 'http://localhost:3000'}/tenant.html"
                   style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px">
                  Go to My Dashboard →
                </a>
              </div>
            </div>
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">© ${new Date().getFullYear()} RentPortal</p>
            </div>
          </div>
        </body>
        </html>`
    });

    console.log(`📧 Welcome email sent to ${email}`);
}


// ════════════════════════════════════════════════
// 2. RENT REMINDER EMAIL
// ════════════════════════════════════════════════

async function sendRentReminder({ name, email, house, rent, month, dueDate, arrears }) {
    const isOverdue = arrears > 0;

    await sendEmail({
        to:      email,
        subject: isOverdue
            ? `⚠️ Rent Overdue — ${month} | ${house}`
            : `🔔 Rent Reminder — ${month} | ${house}`,
        html: `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:${isOverdue ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'linear-gradient(135deg,#d97706,#b45309)'};padding:36px 32px;text-align:center">
              <div style="font-size:44px;margin-bottom:10px">${isOverdue ? '⚠️' : '🔔'}</div>
              <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700">${isOverdue ? 'Rent Overdue' : 'Rent Due Soon'}</h1>
              <p style="color:${isOverdue ? '#fca5a5' : '#fde68a'};margin:8px 0 0;font-size:13px">${month}</p>
            </div>
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${name.split(' ')[0]}</strong>,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                ${isOverdue
                    ? `Your rent for <strong>${month}</strong> is <strong style="color:#dc2626">overdue</strong>. Please pay as soon as possible.`
                    : `Your rent for <strong>${month}</strong> is due on the <strong>${dueDate}${ordinal(dueDate)}</strong>. Please pay on time.`
                }
              </p>
              <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:20px 24px;margin-bottom:28px">
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
              <div style="text-align:center;margin-bottom:28px">
                <a href="${process.env.BASE_URL || 'http://localhost:3000'}/tenant.html"
                   style="display:inline-block;background:${isOverdue ? '#dc2626' : '#d97706'};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px">
                  Pay Rent Now →
                </a>
              </div>
            </div>
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">© ${new Date().getFullYear()} RentPortal · Automated reminder.</p>
            </div>
          </div>
        </body>
        </html>`
    });

    console.log(`📧 Rent reminder sent to ${email} for ${month}`);
}


// ════════════════════════════════════════════════
// 3. MOVE-OUT GOODBYE EMAIL
// ════════════════════════════════════════════════

async function sendMoveOutEmail({ name, email, house, moveOutDate }) {
    await sendEmail({
        to:      email,
        subject: `Goodbye ${name.split(' ')[0]} — Move-out Confirmed 🏠`,
        html: `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🚪</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700">Goodbye, ${name.split(' ')[0]}</h1>
              <p style="color:#94a3b8;margin:8px 0 0;font-size:13px">We hope to see you again someday.</p>
            </div>
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${name.split(' ')[0]}</strong>,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your move-out from <strong>${house}</strong> has been confirmed. It has been a pleasure having you as a tenant!
              </p>
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
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
                      <span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">Moved Out ✓</span>
                    </td>
                  </tr>
                </table>
              </div>
              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                Your account remains active and you can still access your payment history and receipts.
              </p>
            </div>
            <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
              <p style="color:#cbd5e1;font-size:11px;margin:0">© ${new Date().getFullYear()} RentPortal · Take care out there 🌟</p>
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