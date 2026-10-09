// emails.applications.js — NEW (emails.js itself is unchanged).
//
//   createApplicationNotifiers(models) → { notifyApplicationReceived, notifyApplicationDecision }
//
// Both are fire-and-forget: they look up what they need, send through Resend, and only log on failure —
// an email problem must never break an application, an approval or an assignment.

const { Resend } = require('resend');
const { emailIcon } = require('./emails');

const FROM = 'Affordable Rentals <support@affordablerentals.site>';
const DASHBOARD_URL = process.env.BASE_URL || 'http://localhost:3000';

// Escape anything a tenant typed before it goes into HTML.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = name => esc(String(name || '').trim().split(' ')[0] || 'there');

function shell({ headerBg, icon, title, sub, body, cta }) {
    return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
      <div style="background:${headerBg};padding:28px;text-align:center">
        <div style="font-size:36px;margin-bottom:8px">${icon}</div>
        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">${title}</h1>
        <p style="color:#e2e8f0;margin:6px 0 0;font-size:13px">${sub}</p>
      </div>
      <div style="padding:28px">${body}${cta ? `
        <div style="text-align:center;margin-top:22px">
          <a href="${cta.href}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 26px;border-radius:8px;font-size:13px;font-weight:600">${cta.label}</a>
        </div>` : ''}
      </div>
      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 28px;text-align:center">
        <p style="color:#94a3b8;font-size:11px;margin:0">© ${new Date().getFullYear()} Affordable Rentals</p>
      </div>
    </div>`;
}

const row = (k, v) => `<tr><td style="color:#64748b;font-size:13px;padding:6px 0">${k}</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${v}</td></tr>`;

function createApplicationNotifiers({ Tenant, House, HouseGroup, Property, User }) {
    const resend = new Resend(process.env.RESEND_API_KEY);

    async function context(application) {
        const [tenant, house, property, building] = await Promise.all([
            Tenant.findById(application.tenant).select('name email phone'),
            House.findById(application.house).select('name'),
            Property.findById(application.property).select('name landlord'),
            application.building ? HouseGroup.findById(application.building).select('label') : null
        ]);
        return { tenant, house, property, building };
    }

    async function send(payload) {
        const { error } = await resend.emails.send({ from: FROM, ...payload });
        if (error) throw new Error(error.message);
    }

    // → landlord: "X applied for house Y"
    function notifyApplicationReceived({ application }) {
        (async () => {
            const { tenant, house, property, building } = await context(application);
            if (!tenant || !house || !property) return;
            const landlord = await User.findById(property.landlord).select('name email');
            if (!landlord || !landlord.email) return;

            await send({
                to: landlord.email,
                subject: `New house application — ${house.name} · ${property.name}`,
                html: shell({
                    headerBg: 'linear-gradient(135deg,#1d4ed8,#0ea5e9)',
                    icon: emailIcon('houses', 36, 'white'),
                    title: 'New House Application',
                    sub: `${esc(property.name)}${building ? ' · ' + esc(building.label) : ''}`,
                    body: `
                      <p style="color:#1e293b;font-size:14px;margin:0 0 14px">Hi ${first(landlord.name)},</p>
                      <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 18px"><strong>${esc(tenant.name)}</strong> applied for <strong>${esc(house.name)}</strong>. Review it from <strong>Tenants → Applications</strong> in your dashboard.</p>
                      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:16px 20px"><table style="width:100%;border-collapse:collapse">
                        ${row('Tenant', esc(tenant.name))}${row('Phone', esc(tenant.phone))}${row('House', esc(house.name))}${building ? row('Building', esc(building.label)) : ''}
                        ${application.note ? row('Note', esc(application.note)) : ''}
                      </table></div>`,
                    cta: { href: `${DASHBOARD_URL}/dashboard.html`, label: 'Open Applications →' }
                })
            });
        })().catch(err => console.error('Application received email failed:', err.message));
    }

    // → tenant: approved / declined
    function notifyApplicationDecision({ application, approved, note }) {
        (async () => {
            const { tenant, house, property, building } = await context(application);
            if (!tenant || !tenant.email || !house || !property) return;

            await send({
                to: tenant.email,
                subject: approved ? `Approved — you're assigned to ${house.name}` : `Update on your application for ${house.name}`,
                html: shell({
                    headerBg: approved ? 'linear-gradient(135deg,#16a34a,#15803d)' : 'linear-gradient(135deg,#475569,#334155)',
                    icon: approved ? emailIcon('check', 36, 'white') : emailIcon('houses', 36, 'white'),
                    title: approved ? 'Application Approved' : 'Application Update',
                    sub: `${esc(property.name)}${building ? ' · ' + esc(building.label) : ''}`,
                    body: `
                      <p style="color:#1e293b;font-size:14px;margin:0 0 14px">Hi ${first(tenant.name)},</p>
                      <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 ${note ? '14' : '0'}px">${approved
                          ? `Your application for <strong>${esc(house.name)}</strong> was approved and the house is now assigned to you. Log in to see your rent and payment details.`
                          : `Your application for <strong>${esc(house.name)}</strong> was not successful this time. You can browse other available houses from your dashboard and apply again.`}</p>
                      ${note ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;color:#475569;font-size:13px;line-height:1.6">${esc(note)}</div>` : ''}`,
                    cta: { href: `${DASHBOARD_URL}/tenant.html`, label: approved ? 'Go to My Dashboard →' : 'Browse Houses →' }
                })
            });
        })().catch(err => console.error('Application decision email failed:', err.message));
    }

    return { notifyApplicationReceived, notifyApplicationDecision };
}

module.exports = createApplicationNotifiers;
