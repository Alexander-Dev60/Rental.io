// ═══════════════════════════════════════════════════════
//  emails.js — All transactional email templates
//  Sender: support@affordablerentals.site (via Resend)
//
//  Exports:
//    sendWelcomeEmail({ name, email })
//    sendLandlordWelcomeEmail({ name, email, propertyName, propertyLocation })
//    sendTenantWelcomeEmail({ name, email, tempPassword, propertyName, landlordName, isReturning })
//    sendRentReminder({ name, email, house, rent, month, dueDate, arrears })
//    sendMoveOutEmail({ name, email, house, moveOutDate })
//    sendPasswordResetEmail({ name, email, code })
//    sendPaymentOtpEmail({ name, email, code })
//    sendRentReceiptEmail({ tenant, house, month, amount, rent, newTotalPaid, newBalance, newStatus, paymentId })
//    sendMpesaConfirmationEmail({ tenant, house, payment, mpesaCode, newTotalPaid, newBalance, newStatus, pdfBuffer })
//    sendSubscriptionRenewalEmail({ landlord, plan, newExpiry, mpesaCode })
//    sendListingApprovalEmail({ landlord, property, approved, baseUrl })
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

// ── Shared footer snippet ──
function _footer(note) {
    return `
    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center">
      <p style="color:#cbd5e1;font-size:11px;margin:0">
        © ${new Date().getFullYear()} Affordable Rentals ·
        <a href="https://affordablerentals.site" style="color:#94a3b8;text-decoration:none">affordablerentals.site</a>
      </p>
      ${note ? `<p style="color:#e2e8f0;font-size:10px;margin:6px 0 0">${note}</p>` : ''}
    </div>`;
}


// ═══════════════════════════════════════════════════════
// 1. WELCOME EMAIL (existing tenants — no temp password)
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

            <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🏠</div>
              <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;letter-spacing:-0.5px">Welcome to Affordable Rentals</h1>
              <p style="color:#bae6fd;margin:8px 0 0;font-size:14px">Your home, managed well.</p>
            </div>

            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${name.split(' ')[0]}</strong> 👋,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your tenant account has been successfully created on <strong>Affordable Rentals</strong>.
                You can now log in to your dashboard to view your house details,
                make rent payments via M-Pesa, download receipts, and chat with your landlord.
              </p>

              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">YOUR ACCOUNT</p>
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

            ${_footer('You received this because you registered an account.')}
          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Welcome email failed: ${error.message}`);
    console.log(`📧 Welcome email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 2. LANDLORD WELCOME EMAIL
//    Sent immediately after POST /landlord/register.
//    Gives a warm onboarding nudge and links to the dashboard.
// ═══════════════════════════════════════════════════════

async function sendLandlordWelcomeEmail({ name, email, propertyName, propertyLocation }) {
    const firstName = name.split(' ')[0];

    const { error } = await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: `🏢 Welcome aboard, ${firstName} — your property is ready`,
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
            <div style="background:linear-gradient(135deg,#0f172a,#1e3a5f);padding:40px 32px;text-align:center">
              <div style="font-size:52px;margin-bottom:12px">🏢</div>
              <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:700;letter-spacing:-0.5px">
                Welcome to Affordable Rentals
              </h1>
              <p style="color:#7dd3fc;margin:8px 0 0;font-size:13px;letter-spacing:0.04em">
                Kenyan rental management, reimagined.
              </p>
            </div>

            <!-- Body -->
            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">
                Hi <strong>${firstName}</strong> 👋,
              </p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your landlord account and first property have been created successfully.
                You're on a <strong style="color:#1d4ed8">14-day free trial</strong> — no payment needed yet.
                Here's everything you can start doing right now:
              </p>

              <!-- What you can do -->
              <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px 24px;margin-bottom:24px">
                <p style="color:#0369a1;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 14px;font-weight:600">
                  GET STARTED IN MINUTES
                </p>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="padding:7px 0;vertical-align:top;width:28px;color:#1d4ed8;font-size:15px">🏡</td>
                    <td style="padding:7px 0;color:#334155;font-size:13px;line-height:1.5">
                      <strong>Add your houses</strong> — set names and monthly rent amounts
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;vertical-align:top;color:#1d4ed8;font-size:15px">👥</td>
                    <td style="padding:7px 0;color:#334155;font-size:13px;line-height:1.5">
                      <strong>Add tenants</strong> — they'll receive a welcome email with login details
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;vertical-align:top;color:#1d4ed8;font-size:15px">⚙️</td>
                    <td style="padding:7px 0;color:#334155;font-size:13px;line-height:1.5">
                      <strong>Configure M-Pesa</strong> — so tenants can pay rent directly from their dashboard
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;vertical-align:top;color:#1d4ed8;font-size:15px">📢</td>
                    <td style="padding:7px 0;color:#334155;font-size:13px;line-height:1.5">
                      <strong>Post announcements and rules</strong> — visible to all tenants instantly
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:7px 0;vertical-align:top;color:#1d4ed8;font-size:15px">🏷️</td>
                    <td style="padding:7px 0;color:#334155;font-size:13px;line-height:1.5">
                      <strong>List your property publicly</strong> — attract prospective tenants from the listings page
                    </td>
                  </tr>
                </table>
              </div>

              <!-- Property card -->
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 10px;font-weight:600">
                  YOUR FIRST PROPERTY
                </p>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:5px 0">Property Name</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${propertyName}</td>
                  </tr>
                  ${propertyLocation ? `
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:5px 0">Location</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${propertyLocation}</td>
                  </tr>` : ''}
                  <tr>
                    <td style="color:#94a3b8;font-size:13px;padding:5px 0">Trial Period</td>
                    <td style="text-align:right">
                      <span style="background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">
                        14 days free ✓
                      </span>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- CTA -->
              <div style="text-align:center;margin-bottom:28px">
                <a href="${DASHBOARD_URL}/index.html"
                   style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 36px;border-radius:8px;letter-spacing:0.02em">
                  Open My Dashboard →
                </a>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                Need help? Email us at
                <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>
                — we typically respond within a few hours.
              </p>
            </div>

            ${_footer('You received this because you created a landlord account on Affordable Rentals.')}
          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Landlord welcome email failed: ${error.message}`);
    console.log(`📧 Landlord welcome email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 3. TENANT WELCOME EMAIL — SaaS version
//    Sent when a landlord creates a tenant account.
//    Includes temporary password + forced change notice.
// ═══════════════════════════════════════════════════════

async function sendTenantWelcomeEmail({ name, email, tempPassword, propertyName, landlordName, isReturning = false }) {
    const firstName = name.split(' ')[0];

    const returningHtml = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🏠</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px">You've been added to ${propertyName}</h1>
              <p style="color:#bae6fd;margin:8px 0 0;font-size:13px">Managed by ${landlordName} · Affordable Rentals</p>
            </div>

            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${firstName}</strong> 👋,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                <strong>${landlordName}</strong> has added you as a tenant at <strong>${propertyName}</strong>
                on <strong>Affordable Rentals</strong>. Your existing account is now linked to this property —
                just log in with your current password.
              </p>

              <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:24px;margin-bottom:24px">
                <p style="color:#0369a1;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 16px;font-weight:600">YOUR ACCOUNT</p>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="color:#64748b;font-size:13px;padding:8px 0">Email</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right;font-family:'Courier New',monospace">${email}</td>
                  </tr>
                  <tr>
                    <td style="color:#64748b;font-size:13px;padding:8px 0">Password</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">Your existing password</td>
                  </tr>
                  <tr>
                    <td style="color:#64748b;font-size:13px;padding:8px 0">Property</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${propertyName}</td>
                  </tr>
                </table>
              </div>

              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">WITH YOUR ACCOUNT YOU CAN</p>
                <table style="width:100%;border-collapse:collapse">
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">💳</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">Pay rent via M-Pesa directly from your dashboard</td></tr>
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">🧾</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">Download payment receipts anytime</td></tr>
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">💬</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">Message your landlord directly</td></tr>
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">📋</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">View house rules and announcements</td></tr>
                </table>
              </div>

              <div style="text-align:center;margin-bottom:28px">
                <a href="${DASHBOARD_URL}/auth.html"
                   style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px;letter-spacing:0.02em">
                  Login to My Dashboard →
                </a>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                If you have any questions, contact your landlord via the dashboard or email us at
                <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>.
              </p>
            </div>

            ${_footer('You received this because your landlord added you to their property management system.')}
          </div>
        </body>
        </html>`;

    const newTenantHtml = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🏠</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px">Welcome to ${propertyName}</h1>
              <p style="color:#bae6fd;margin:8px 0 0;font-size:13px">Managed by ${landlordName} · Affordable Rentals</p>
            </div>

            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${firstName}</strong> 👋,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your landlord, <strong>${landlordName}</strong>, has created a tenant account for you on
                <strong>Affordable Rentals</strong>. Use the temporary password below to log in,
                then you'll be asked to set a new password of your choice.
              </p>

              <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:24px;margin-bottom:24px">
                <p style="color:#0369a1;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 16px;font-weight:600">YOUR LOGIN CREDENTIALS</p>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="color:#64748b;font-size:13px;padding:8px 0;vertical-align:middle">Email</td>
                    <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right;font-family:'Courier New',monospace">${email}</td>
                  </tr>
                  <tr>
                    <td style="color:#64748b;font-size:13px;padding:8px 0;vertical-align:middle">Temporary Password</td>
                    <td style="text-align:right">
                      <span style="background:#1d4ed8;color:#ffffff;font-family:'Courier New',monospace;font-size:15px;font-weight:700;padding:6px 14px;border-radius:6px;letter-spacing:2px;display:inline-block">
                        ${tempPassword}
                      </span>
                    </td>
                  </tr>
                </table>
              </div>

              <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:24px">
                <p style="color:#92400e;font-size:13px;margin:0;font-weight:600">⚠️ Important</p>
                <p style="color:#78350f;font-size:13px;line-height:1.6;margin:6px 0 0">
                  You will be required to change this temporary password immediately after your first login.
                  Choose a strong password that only you know.
                </p>
              </div>

              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">WITH YOUR ACCOUNT YOU CAN</p>
                <table style="width:100%;border-collapse:collapse">
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">💳</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">Pay rent via M-Pesa directly from your dashboard</td></tr>
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">🧾</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">Download payment receipts anytime</td></tr>
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">💬</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">Message your landlord directly</td></tr>
                  <tr><td style="color:#475569;font-size:13px;padding:5px 0">📋</td><td style="color:#475569;font-size:13px;padding:5px 0 5px 8px">View house rules and announcements</td></tr>
                </table>
              </div>

              <div style="text-align:center;margin-bottom:28px">
                <a href="${DASHBOARD_URL}/auth.html"
                   style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px;letter-spacing:0.02em">
                  Login to My Dashboard →
                </a>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                If you have any questions, contact your landlord via the dashboard or email us at
                <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>.
              </p>
            </div>

            ${_footer('You received this because your landlord added you to their property management system.')}
          </div>
        </body>
        </html>`;

    const { error } = await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: isReturning
            ? `🏠 You've been added to ${propertyName}`
            : `🏠 You've been added to ${propertyName} — Login Details Inside`,
        html: isReturning ? returningHtml : newTenantHtml
    });

    if (error) throw new Error(`Tenant welcome email failed: ${error.message}`);
    console.log(`📧 Tenant ${isReturning ? 'notification' : 'welcome'} email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 4. RENT REMINDER EMAIL
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

            <div style="background:${isOverdue ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'linear-gradient(135deg,#d97706,#b45309)'};padding:36px 32px;text-align:center">
              <div style="font-size:44px;margin-bottom:10px">${isOverdue ? '⚠️' : '🔔'}</div>
              <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700">${isOverdue ? 'Rent Overdue' : 'Rent Due Soon'}</h1>
              <p style="color:${isOverdue ? '#fca5a5' : '#fde68a'};margin:8px 0 0;font-size:13px">${month}</p>
            </div>

            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${name.split(' ')[0]}</strong>,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                ${isOverdue
                    ? `Your rent for <strong>${month}</strong> is <strong style="color:#dc2626">overdue</strong>. Please make your payment as soon as possible.`
                    : `Your rent for <strong>${month}</strong> is due on the <strong>${dueDate}${ordinal(dueDate)}</strong>. Please ensure payment is made on time.`
                }
              </p>

              <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#92400e;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">PAYMENT DETAILS</p>
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
                <a href="${DASHBOARD_URL}/tenant.html"
                   style="display:inline-block;background:${isOverdue ? '#dc2626' : '#d97706'};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px">
                  Pay Rent Now →
                </a>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                If you have already made payment, please ignore this email.
              </p>
            </div>

            ${_footer('Automated rent reminder.')}
          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Rent reminder failed: ${error.message}`);
    console.log(`📧 Rent reminder sent to ${email} for ${month}`);
}


// ═══════════════════════════════════════════════════════
// 5. MOVE-OUT GOODBYE EMAIL
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

            <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🚪</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700">Goodbye, ${name.split(' ')[0]}</h1>
              <p style="color:#94a3b8;margin:8px 0 0;font-size:13px">We hope to see you again someday.</p>
            </div>

            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${name.split(' ')[0]}</strong>,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                Your move-out from <strong>${house}</strong> has been confirmed.
                It has been a pleasure having you as a tenant. We wish you all the best in your new place!
              </p>

              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">MOVE-OUT SUMMARY</p>
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
                      <span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">Moved Out ✓</span>
                    </td>
                  </tr>
                </table>
              </div>

              <div style="background:#eff6ff;border-radius:10px;padding:20px 24px;margin-bottom:28px;text-align:center">
                <p style="color:#1d4ed8;font-size:14px;line-height:1.7;margin:0;font-style:italic">
                  "Thank you for being part of our community.
                   Your receipts and payment history remain accessible via your account."
                </p>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                If you believe this move-out was processed in error, contact your landlord or email
                <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>.
              </p>
            </div>

            ${_footer('Take care out there 🌟')}
          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Move-out email failed: ${error.message}`);
    console.log(`📧 Move-out email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 6. PASSWORD RESET EMAIL
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

            <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🔑</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700">Password Reset</h1>
              <p style="color:#bae6fd;margin:8px 0 0;font-size:13px">Use the code below to reset your password</p>
            </div>

            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${name.split(' ')[0]}</strong>,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 28px">
                We received a request to reset your password. Use the 6-digit code below to proceed.
                This code expires in <strong>15 minutes</strong>.
              </p>

              <div style="background:#f0f9ff;border:2px dashed #0ea5e9;border-radius:12px;padding:28px 24px;text-align:center;margin-bottom:28px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 16px;font-weight:600">YOUR RESET CODE</p>
                <span style="font-family:'Courier New',monospace;font-size:42px;font-weight:900;letter-spacing:12px;color:#1d4ed8;display:block;line-height:1">
                  ${code}
                </span>
                <p style="color:#94a3b8;font-size:12px;margin:16px 0 0">Expires in 15 minutes · Do not share this code</p>
              </div>

              <div style="text-align:center;margin-bottom:28px">
                <a href="${DASHBOARD_URL}/forgot-password.html"
                   style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:8px;letter-spacing:0.02em">
                  Reset My Password →
                </a>
              </div>

              <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin-bottom:20px">
                <p style="color:#991b1b;font-size:12px;line-height:1.6;margin:0;font-weight:600">🛡️ Security Notice</p>
                <p style="color:#b91c1c;font-size:12px;line-height:1.6;margin:8px 0 0">
                  If you did not request a password reset, please ignore this email. Never share this code with anyone.
                </p>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                Having trouble? Contact us at
                <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>
              </p>
            </div>

            ${_footer('You received this because a password reset was requested for your account.')}
          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Password reset email failed: ${error.message}`);
    console.log(`📧 Password reset email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 7. PAYMENT OTP EMAIL
//    Sent when a landlord requests to edit their M-Pesa
//    credentials. OTP expires in 15 minutes.
// ═══════════════════════════════════════════════════════

async function sendPaymentOtpEmail({ name, email, code }) {
    const firstName = name.split(' ')[0];

    const { error } = await resend.emails.send({
        from:    FROM,
        to:      email,
        subject: `🔐 M-Pesa Credentials OTP — ${code}`,
        html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

            <!-- Header -->
            <div style="background:linear-gradient(135deg,#065f46,#047857);padding:40px 32px;text-align:center">
              <div style="font-size:48px;margin-bottom:12px">🔐</div>
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700">M-Pesa Credentials Update</h1>
              <p style="color:#a7f3d0;margin:8px 0 0;font-size:13px">One-time verification code</p>
            </div>

            <div style="padding:36px 32px">
              <p style="color:#1e293b;font-size:16px;margin:0 0 16px">Hi <strong>${firstName}</strong>,</p>
              <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                You requested to update your M-Pesa payment credentials on <strong>Affordable Rentals</strong>.
                Enter the verification code below in your dashboard to proceed.
                This code expires in <strong>15 minutes</strong>.
              </p>

              <!-- OTP box -->
              <div style="background:#ecfdf5;border:2px dashed #059669;border-radius:12px;padding:28px 24px;text-align:center;margin-bottom:28px">
                <p style="color:#065f46;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 16px;font-weight:600">
                  YOUR VERIFICATION CODE
                </p>
                <span style="font-family:'Courier New',monospace;font-size:42px;font-weight:900;letter-spacing:12px;color:#065f46;display:block;line-height:1">
                  ${code}
                </span>
                <p style="color:#6b7280;font-size:12px;margin:16px 0 0">
                  Expires in 15 minutes · Do not share this code
                </p>
              </div>

              <!-- Security warning -->
              <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin-bottom:24px">
                <p style="color:#991b1b;font-size:12px;font-weight:600;margin:0">🛡️ Security Notice</p>
                <p style="color:#b91c1c;font-size:12px;line-height:1.6;margin:8px 0 0">
                  Your M-Pesa credentials are encrypted with AES-256 and stored securely.
                  If you did not request this change, please contact support immediately —
                  your credentials have not been altered yet.
                </p>
              </div>

              <!-- What changes -->
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:24px">
                <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 10px;font-weight:600">
                  WHAT HAPPENS NEXT
                </p>
                <p style="color:#475569;font-size:13px;line-height:1.65;margin:0">
                  After you enter this code and submit your new credentials, your Paybill, Consumer Key,
                  Consumer Secret and Passkey will be updated and encrypted immediately.
                  Tenants will be able to pay rent using the new configuration right away.
                </p>
              </div>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0">
                Need help? Email us at
                <a href="mailto:support@affordablerentals.site" style="color:#065f46">support@affordablerentals.site</a>
              </p>
            </div>

            ${_footer('You received this because a credential update was requested from your landlord account.')}
          </div>
        </body>
        </html>`
    });

    if (error) throw new Error(`Payment OTP email failed: ${error.message}`);
    console.log(`📧 Payment OTP email sent to ${email}`);
}


// ═══════════════════════════════════════════════════════
// 8. RENT RECEIPT EMAIL  (extracted from POST /payments)
//    Accepts a pre-built pdfBuffer so server.js only calls
//    this once — no inline Resend code left in the route.
// ═══════════════════════════════════════════════════════

async function sendRentReceiptEmail({
    tenant,       // populated Tenant document
    house,        // populated House document
    month,
    amount,
    rent,
    newTotalPaid,
    newBalance,
    newStatus,
    paymentId,
    pdfBuffer     // Buffer — attached as PDF receipt
}) {
    const statusColor = newStatus === 'paid' ? '#16a34a' : '#d97706';
    const statusLabel = newStatus === 'paid' ? 'Fully Paid ✓' : 'Partial Payment';
    const statusBg    = newStatus === 'paid' ? '#dcfce7' : '#fef3c7';

    const { error } = await resend.emails.send({
        from:    FROM,
        to:      tenant.email,
        subject: `${newStatus === 'paid' ? '✅' : '🔔'} Rent Receipt — ${month} | ${house.name}`,
        html: `
        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:32px;text-align:center">
            <div style="font-size:40px;margin-bottom:8px">🧾</div>
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Payment Received</h1>
            <p style="color:#bae6fd;margin:6px 0 0;font-size:13px">${month}</p>
          </div>
          <div style="padding:32px">
            <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${tenant.name.split(' ')[0]}</strong>,</p>
            <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
              Your payment of <strong>Ksh ${Number(amount).toLocaleString()}</strong> for <strong>${month}</strong> has been recorded successfully.
            </p>
            <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px 24px;margin-bottom:24px">
              <p style="color:#64748b;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 12px;font-weight:600">PAYMENT BREAKDOWN</p>
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">House</td>             <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${house.name}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Month</td>             <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${month}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Monthly Rent</td>      <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">Ksh ${Number(rent).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">This Payment</td>      <td style="color:#1d4ed8;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(amount).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Total Paid</td>        <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">Ksh ${Number(newTotalPaid).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Balance Remaining</td> <td style="color:${newBalance > 0 ? '#d97706' : '#16a34a'};font-size:13px;font-weight:700;text-align:right">Ksh ${Number(newBalance).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Status</td>            <td style="text-align:right"><span style="background:${statusBg};color:${statusColor};font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">${statusLabel}</span></td></tr>
              </table>
            </div>
            ${newBalance > 0 ? `
            <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:20px">
              <p style="color:#92400e;font-size:13px;margin:0">⚠️ You still have a balance of <strong>Ksh ${Number(newBalance).toLocaleString()}</strong> for ${month}. Please pay before your due date.</p>
            </div>` : ''}
            <p style="color:#94a3b8;font-size:12px;margin:0">PDF receipt is attached. Contact us at <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a> for queries.</p>
          </div>
          ${_footer(`© ${new Date().getFullYear()} Affordable Rentals`)}
        </div>`,
        attachments: pdfBuffer
            ? [{ filename: `receipt-${paymentId}.pdf`, content: pdfBuffer.toString('base64') }]
            : []
    });

    if (error) throw new Error(`Receipt email failed: ${error.message}`);
    console.log(`📧 Receipt email sent to ${tenant.email}`);
}


// ═══════════════════════════════════════════════════════
// 9. M-PESA CONFIRMATION EMAIL  (extracted from /callback)
//    Sent after Safaricom confirms an STK push payment.
// ═══════════════════════════════════════════════════════

async function sendMpesaConfirmationEmail({
    tenant,        // populated Tenant document
    house,         // populated House document (may be from payment.house)
    payment,       // Payment document (for month, amount)
    mpesaCode,
    newTotalPaid,
    newBalance,
    newStatus
}) {
    const statusColor = newStatus === 'paid' ? '#16a34a' : '#d97706';
    const statusLabel = newStatus === 'paid' ? 'Fully Paid ✓' : 'Partial Payment';
    const statusBg    = newStatus === 'paid' ? '#dcfce7' : '#fef3c7';
    const houseName   = house?.name || '—';

    const { error } = await resend.emails.send({
        from:    FROM,
        to:      tenant.email,
        subject: `${newStatus === 'paid' ? '✅' : '🔔'} M-Pesa Payment Confirmed — ${payment.month}`,
        html: `
        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#16a34a,#15803d);padding:32px;text-align:center">
            <div style="font-size:40px;margin-bottom:8px">✅</div>
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Payment Confirmed</h1>
            <p style="color:#bbf7d0;margin:6px 0 0;font-size:13px">${payment.month}</p>
          </div>
          <div style="padding:32px">
            <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${tenant.name.split(' ')[0]}</strong>,</p>
            <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">Your M-Pesa payment has been received and confirmed.</p>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;margin-bottom:24px">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">House</td>        <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${houseName}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Month</td>        <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${payment.month}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">This Payment</td> <td style="color:#16a34a;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(payment.amount).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Total Paid</td>   <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">Ksh ${Number(newTotalPaid).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Balance</td>      <td style="color:${newBalance > 0 ? '#d97706' : '#16a34a'};font-size:13px;font-weight:700;text-align:right">Ksh ${Number(newBalance).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">M-Pesa Code</td>  <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right;font-family:monospace">${mpesaCode}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Status</td>       <td style="text-align:right"><span style="background:${statusBg};color:${statusColor};font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">${statusLabel}</span></td></tr>
              </table>
            </div>
            ${newBalance > 0 ? `
            <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:20px">
              <p style="color:#92400e;font-size:13px;margin:0">⚠️ Balance remaining: <strong>Ksh ${Number(newBalance).toLocaleString()}</strong>. Please pay before your due date.</p>
            </div>` : ''}
            <p style="color:#94a3b8;font-size:12px;margin:0">Keep this as your receipt. Contact <a href="mailto:support@affordablerentals.site" style="color:#16a34a">support@affordablerentals.site</a> for queries.</p>
          </div>
          ${_footer(`© ${new Date().getFullYear()} Affordable Rentals`)}
        </div>`
    });

    if (error) throw new Error(`M-Pesa confirmation email failed: ${error.message}`);
    console.log(`📧 M-Pesa confirmation email sent to ${tenant.email}`);
}


// ═══════════════════════════════════════════════════════
// 10. SUBSCRIPTION RENEWAL EMAIL  (extracted from /subscription-callback)
// ═══════════════════════════════════════════════════════

async function sendSubscriptionRenewalEmail({ landlord, plan, newExpiry, mpesaCode }) {
    const { error } = await resend.emails.send({
        from:    FROM,
        to:      landlord.email,
        subject: `✅ Subscription Renewed — ${plan.name} Plan`,
        html: `
        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:32px;text-align:center">
            <div style="font-size:40px;margin-bottom:8px">🎉</div>
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Subscription Renewed!</h1>
            <p style="color:#bae6fd;margin:6px 0 0;font-size:13px">${plan.name} Plan</p>
          </div>
          <div style="padding:32px">
            <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${landlord.name.split(' ')[0]}</strong>,</p>
            <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">Your subscription has been renewed. You have full access to your dashboard.</p>
            <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px 24px;margin-bottom:24px">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Plan</td>         <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${plan.name}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Amount Paid</td>  <td style="color:#1d4ed8;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(plan.price).toLocaleString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Duration</td>     <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${plan.durationDays} days</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Valid Until</td>  <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${new Date(newExpiry).toDateString()}</td></tr>
                <tr><td style="color:#64748b;font-size:13px;padding:6px 0">M-Pesa Code</td> <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right;font-family:monospace">${mpesaCode}</td></tr>
              </table>
            </div>
            <p style="color:#94a3b8;font-size:12px;margin:0">Contact <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a> for any queries.</p>
          </div>
          ${_footer(`© ${new Date().getFullYear()} Affordable Rentals`)}
        </div>`
    });

    if (error) throw new Error(`Subscription renewal email failed: ${error.message}`);
    console.log(`📧 Subscription renewal email sent to ${landlord.email}`);
}


// ═══════════════════════════════════════════════════════
// 11. LISTING APPROVAL EMAIL  (extracted from /stacklord/properties/:id/approve)
//     approved: true  → property is now live
//     approved: false → listing has been paused
// ═══════════════════════════════════════════════════════

async function sendListingApprovalEmail({ landlord, property, approved, baseUrl }) {
    const base = baseUrl || process.env.BASE_URL || 'https://affordablerentals.site';

    const approvedHtml = `
        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#16a34a,#15803d);padding:28px;text-align:center">
            <div style="font-size:36px;margin-bottom:8px">🏡</div>
            <h1 style="color:#fff;margin:0;font-size:20px">Your listing is live!</h1>
          </div>
          <div style="padding:28px">
            <p style="color:#475569;font-size:14px;line-height:1.7">
              <strong>${property.name}</strong>${property.location ? ' in ' + property.location : ''}
              is now visible to prospective tenants on the Affordable Rentals listings page.
            </p>
            <a href="${base}/listings.html"
               style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;margin-top:12px">
              View Listings →
            </a>
          </div>
          ${_footer(null)}
        </div>`;

    const revokedHtml = `
        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:40px auto;padding:28px;background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <p style="color:#475569;font-size:14px;line-height:1.7">
            Your listing for <strong>${property.name}</strong> has been paused by an administrator.
            Please contact
            <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a>
            for more information.
          </p>
          ${_footer(null)}
        </div>`;

    const { error } = await resend.emails.send({
        from:    FROM,
        to:      landlord.email,
        subject: approved
            ? `✅ Your listing is live — ${property.name}`
            : `⚠️ Listing paused — ${property.name}`,
        html: approved ? approvedHtml : revokedHtml
    });

    if (error) throw new Error(`Listing approval email failed: ${error.message}`);
    console.log(`📧 Listing ${approved ? 'approval' : 'revocation'} email sent to ${landlord.email}`);
}


// ═══════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════

module.exports = {
    sendWelcomeEmail,
    sendLandlordWelcomeEmail,
    sendTenantWelcomeEmail,
    sendRentReminder,
    sendMoveOutEmail,
    sendPasswordResetEmail,
    sendPaymentOtpEmail,
    sendRentReceiptEmail,
    sendMpesaConfirmationEmail,
    sendSubscriptionRenewalEmail,
    sendListingApprovalEmail
};