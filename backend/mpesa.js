// ═══════════════════════════════════════════════════════
//  mpesa.js  —  Production M-Pesa Integration Module
//  Drop this file in your project root alongside server.js
//  Then in server.js: const mpesa = require('./mpesa');
// ═══════════════════════════════════════════════════════

const axios       = require('axios');
const PDFDocument = require('pdfkit');
const nodemailer  = require('nodemailer');

// ── Models (passed in during init to avoid circular deps) ──
let Tenant, Payment, House;

function init(models) {
    Tenant  = models.Tenant;
    Payment = models.Payment;
    House   = models.House;
}

// ── Mailer ──
function getTransporter() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
        }
    });
}

// ═══════════════════════════════════════════
// TOKEN — Production
// ═══════════════════════════════════════════

async function getToken() {
    const auth = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const res = await axios.get(
        'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
    );

    return res.data.access_token;
}

// ═══════════════════════════════════════════
// PHONE NORMALIZATION
// ═══════════════════════════════════════════

// Converts any Kenyan format to 254XXXXXXXXX
function normalizePhone(phone) {
    let p = String(phone).replace(/\s+/g, '').replace(/\+/g, '');
    if (p.startsWith('0'))   p = '254' + p.slice(1);
    if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
    return p;
}

// For matching callback phone back to tenant
// Callback returns 254XXXXXXXXX, DB stores 07XXXXXXXX or 254XXXXXXXXX
function phonesMatch(dbPhone, callbackPhone) {
    return normalizePhone(dbPhone) === normalizePhone(callbackPhone);
}

// ═══════════════════════════════════════════
// STK PUSH — Production Paybill
// ═══════════════════════════════════════════

async function stkPush({ phone, amount, accountRef, tenantId }) {
    const token     = await getToken();
    const timestamp = new Date()
        .toISOString()
        .replace(/[-T:.Z]/g, '')
        .slice(0, 14);

    const password = Buffer.from(
        process.env.MPESA_SHORTCODE +
        process.env.MPESA_PASSKEY   +
        timestamp
    ).toString('base64');

    const formattedPhone = normalizePhone(phone);

    const payload = {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        TransactionType:   'CustomerPayBillOnline',   // Paybill
        Amount:            Math.ceil(Number(amount)), // must be integer
        PartyA:            formattedPhone,
        PartyB:            process.env.MPESA_SHORTCODE,
        PhoneNumber:       formattedPhone,
        CallBackURL:       process.env.MPESA_CALLBACK_URL,
        AccountReference:  accountRef || 'Rent',
        TransactionDesc:   'Rent Payment'
    };

    const response = await axios.post(
        'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    return {
        ...response.data,
        tenantId,        // carry tenantId so callback can look it up
        phone: formattedPhone,
        amount,
        timestamp
    };
}

// ═══════════════════════════════════════════
// PENDING PAYMENTS STORE
// In-memory map: CheckoutRequestID → { tenantId, amount, month, status }
// For production you should persist this in MongoDB instead
// ═══════════════════════════════════════════

const pendingPayments = new Map();

function storePending(checkoutRequestId, data) {
    pendingPayments.set(checkoutRequestId, {
        ...data,
        status:    'pending',
        createdAt: Date.now()
    });

    // Auto-expire after 5 minutes
    setTimeout(() => {
        const entry = pendingPayments.get(checkoutRequestId);
        if (entry && entry.status === 'pending') {
            pendingPayments.set(checkoutRequestId, { ...entry, status: 'timeout' });
        }
    }, 5 * 60 * 1000);
}

function getPending(checkoutRequestId) {
    return pendingPayments.get(checkoutRequestId) || null;
}

function updatePending(checkoutRequestId, updates) {
    const entry = pendingPayments.get(checkoutRequestId);
    if (entry) pendingPayments.set(checkoutRequestId, { ...entry, ...updates });
}

// ═══════════════════════════════════════════
// PDF RECEIPT GENERATOR
// ═══════════════════════════════════════════

function generateReceiptPDF({ tenant, house, amount, month, paymentId, datePaid }) {
    return new Promise((resolve, reject) => {
        const doc     = new PDFDocument({ margin: 50 });
        const buffers = [];

        doc.on('data',  chunk => buffers.push(chunk));
        doc.on('end',   ()    => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // Header bar
        doc.rect(0, 0, doc.page.width, 80).fill('#7c3aed');

        doc.fillColor('#ffffff')
           .font('Helvetica-Bold')
           .fontSize(22)
           .text('RENT RECEIPT', 50, 25, { align: 'center' });

        doc.fillColor('#ede9fe')
           .font('Helvetica')
           .fontSize(9)
           .text('RentalPortal Management System', 50, 55, { align: 'center' });

        // Body
        doc.moveDown(4);

        const lineY = (n) => 110 + (n * 28);

        const row = (label, value, n, highlight = false) => {
            doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(label, 60, lineY(n));
            doc.fillColor(highlight ? '#7c3aed' : '#1e293b')
               .font(highlight ? 'Helvetica-Bold' : 'Helvetica')
               .fontSize(highlight ? 13 : 11)
               .text(value, 200, lineY(n));
            doc.moveTo(60, lineY(n) + 18).lineTo(540, lineY(n) + 18).strokeColor('#f1f5f9').lineWidth(0.5).stroke();
        };

        row('Tenant Name',    tenant.name,                       0);
        row('House',          house.name,                         1);
        row('Month',          month,                              2);
        row('Amount Paid',    `Ksh ${Number(amount).toLocaleString()}`, 3, true);
        row('Date Paid',      new Date(datePaid).toDateString(), 4);
        row('Payment ID',     String(paymentId),                 5);
        row('Payment Method', 'M-Pesa',                          6);

        // Footer
        doc.rect(0, doc.page.height - 60, doc.page.width, 60).fill('#f8fafc');

        doc.fillColor('#64748b')
           .font('Helvetica')
           .fontSize(8)
           .text('Thank you for your payment. This is an official receipt.', 50, doc.page.height - 40, { align: 'center' });

        doc.end();
    });
}

// ═══════════════════════════════════════════
// EMAIL RECEIPT
// ═══════════════════════════════════════════

async function emailReceipt({ tenant, house, amount, month, paymentId, datePaid }) {
    const pdfBuffer = await generateReceiptPDF({ tenant, house, amount, month, paymentId, datePaid });

    const transporter = getTransporter();

    await transporter.sendMail({
        from:    `RentalPortal <${process.env.GMAIL_USER}>`,
        to:      tenant.email,
        subject: `✅ Rent Receipt — ${month}`,
        html: `
            <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
                <div style="background:#7c3aed;padding:24px;border-radius:8px 8px 0 0;text-align:center">
                    <h2 style="color:#fff;margin:0">🏠 Rent Receipt</h2>
                </div>
                <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0">
                    <p style="color:#475569">Hi <strong>${tenant.name}</strong>,</p>
                    <p style="color:#475569">Your rent payment has been received. Details below:</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0">
                        <tr style="border-bottom:1px solid #e2e8f0">
                            <td style="padding:8px 0;color:#94a3b8;font-size:13px">House</td>
                            <td style="padding:8px 0;color:#1e293b;font-weight:600">${house.name}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0">
                            <td style="padding:8px 0;color:#94a3b8;font-size:13px">Month</td>
                            <td style="padding:8px 0;color:#1e293b;font-weight:600">${month}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #e2e8f0">
                            <td style="padding:8px 0;color:#94a3b8;font-size:13px">Amount</td>
                            <td style="padding:8px 0;color:#7c3aed;font-weight:700;font-size:16px">Ksh ${Number(amount).toLocaleString()}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0;color:#94a3b8;font-size:13px">Date</td>
                            <td style="padding:8px 0;color:#1e293b">${new Date(datePaid).toDateString()}</td>
                        </tr>
                    </table>
                    <p style="color:#64748b;font-size:12px">PDF receipt attached. Keep it for your records.</p>
                </div>
            </div>`,
        attachments: [{
            filename: `receipt-${month.replace(/\s/g, '-')}.pdf`,
            content:  pdfBuffer
        }]
    });
}

// ═══════════════════════════════════════════
// PROCESS CALLBACK — Core logic
// Called by POST /callback route in server.js
// ═══════════════════════════════════════════

async function processCallback(body) {
    const result = body?.Body?.stkCallback;
    if (!result) return { ok: false, reason: 'Malformed callback body' };

    const checkoutRequestId = result.CheckoutRequestID;

    // ── FAILED PAYMENT ──
    if (result.ResultCode !== 0) {
        console.log(`❌ M-Pesa failed [${checkoutRequestId}]: ${result.ResultDesc}`);
        updatePending(checkoutRequestId, {
            status:     'failed',
            resultDesc: result.ResultDesc
        });
        return { ok: false, reason: result.ResultDesc };
    }

    // ── SUCCESSFUL PAYMENT ──
    const metadata   = result.CallbackMetadata?.Item || [];
    const amount     = metadata.find(i => i.Name === 'Amount')?.Value;
    const mpesaCode  = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
    const phone      = metadata.find(i => i.Name === 'PhoneNumber')?.Value;
    const txDate     = metadata.find(i => i.Name === 'TransactionDate')?.Value;

    console.log(`✅ M-Pesa success: ${mpesaCode} | Ksh ${amount} | ${phone}`);

    // ── Find pending entry ──
    const pending = getPending(checkoutRequestId);

    let tenantId = pending?.tenantId;
    let month    = pending?.month;

    // ── Fallback: find tenant by phone if pending not found ──
    if (!tenantId) {
        const tenant = await Tenant.findOne();
        const allTenants = await Tenant.find();
        const matched = allTenants.find(t => phonesMatch(t.phone, phone));
        if (matched) tenantId = matched._id;
    }

    if (!tenantId) {
        console.warn('⚠️ Could not match tenant for phone:', phone);
        updatePending(checkoutRequestId, { status: 'unmatched', phone, amount });
        return { ok: false, reason: 'Tenant not found for phone ' + phone };
    }

    // ── Default month to current if not found ──
    if (!month) {
        month = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    }

    // ── Load tenant + house ──
    const tenant = await Tenant.findById(tenantId).populate('house');
    if (!tenant || !tenant.house) {
        console.warn('⚠️ Tenant or house not found for id:', tenantId);
        updatePending(checkoutRequestId, { status: 'error', reason: 'no_house' });
        return { ok: false, reason: 'Tenant/house not found' };
    }

    // ── Prevent duplicate payment ──
    const existing = await Payment.findOne({ tenant: tenantId, month });
    if (existing) {
        console.log(`ℹ️ Payment for ${month} already exists for tenant ${tenant.name}`);
        updatePending(checkoutRequestId, { status: 'duplicate' });
        return { ok: true, reason: 'duplicate', paymentId: existing._id };
    }

    // ── Save payment ──
    const payment = await Payment.create({
        tenant:   tenantId,
        house:    tenant.house._id,
        amount:   Number(amount),
        month,
        status:   'paid',
        datePaid: new Date()
    });

    console.log(`💾 Payment saved: ${payment._id}`);

    // ── Update pending status ──
    updatePending(checkoutRequestId, {
        status:    'confirmed',
        paymentId: payment._id,
        mpesaCode
    });

    // ── Email receipt (non-blocking) ──
    emailReceipt({
        tenant,
        house:     tenant.house,
        amount:    Number(amount),
        month,
        paymentId: payment._id,
        datePaid:  payment.datePaid
    }).catch(err => console.error('📧 Email failed:', err.message));

    return { ok: true, paymentId: payment._id, mpesaCode };
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

module.exports = {
    init,
    getToken,
    stkPush,
    storePending,
    getPending,
    updatePending,
    processCallback,
    normalizePhone
};