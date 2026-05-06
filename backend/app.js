'use strict';

const express = require('express');
const app     = express();
const cors    = require('cors');
const app     = express();
const cors    = require('cors');
require('dotenv').config();

app.use(cors());
app.use(express.json());

const PDFDocument = require('pdfkit');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const axios       = require('axios');
const cron        = require('node-cron');
const crypto      = require('crypto');

// ── Email functions ──
const {
    sendWelcomeEmail,
    sendRentReminder,
    sendMoveOutEmail,
    sendPasswordResetEmail
} = require('./emails');

// ── Models ──
const Tenant       = require('./models/Tenant');
const House        = require('./models/House');
const Payment      = require('./models/Payment');
const User         = require('./models/User');
const Rule         = require('./models/Rule');
const Announcement = require('./models/Announcement');
const Message      = require('./models/Message');
const Settings     = require('./models/Settings');
const Settings     = require('./models/Settings');

// ── DB ──
const connectDB = require('./db');
connectDB();


// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'No token' });

    try {
        const token   = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid token' });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

// ── In-memory OTP store { email: { code, expiresAt, name } } ──
// For production scale, replace with a Redis store or DB collection
const otpStore = new Map();

// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'No token' });

    try {
        const token   = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid token' });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

// ═══════════════════════════════════════
// MAINTENANCE MODE
// ═══════════════════════════════════════
// ═══════════════════════════════════════
// MAINTENANCE MODE
// ═══════════════════════════════════════

// GET /maintenance — PUBLIC
app.get('/maintenance', async (req, res) => {
    try {
        const settings = await Settings.findOne();
        if (!settings) return res.json({ maintenanceMode: false, maintenanceMessage: '' });
        res.json({
            maintenanceMode:    settings.maintenanceMode,
            maintenanceMessage: settings.maintenanceMessage
        });
    } catch (err) {
        res.json({ maintenanceMode: false, maintenanceMessage: '' });
    }
});

// PUT /maintenance — ADMIN ONLY
app.put('/maintenance', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { maintenanceMode, maintenanceMessage } = req.body;

        const settings = await Settings.findOneAndUpdate(
            {},
            {
                maintenanceMode:    Boolean(maintenanceMode),
                maintenanceMessage: maintenanceMessage || 'The system is currently under maintenance. Please check back later.',
                updatedAt:          new Date()
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        res.json({
            message:         `Maintenance mode ${maintenanceMode ? 'enabled 🔧' : 'disabled ✅'}`,
            maintenanceMode: settings.maintenanceMode
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to update maintenance mode' });
    }
});

// ═══════════════════════════════════════
// M-PESA HELPER
// ═══════════════════════════════════════

async function getToken() {
    const auth = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const res = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
    );

    return res.data.access_token;
}

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════

// POST /register
app.post('/register', async (req, res) => {
    try {
        const { name, email, password, phone, dueDate } = req.body;

        if (!name || !email || !password || !phone) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'An account with this email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const tenant = await Tenant.create({
            name,
            email,
            phone,
            dueDate: dueDate || 5
        });

        const user = await User.create({
            name,
            email,
            password: hashedPassword,
            role:     'tenant',
            tenantId: tenant._id
        });

        // Send welcome email — non-blocking
        sendWelcomeEmail({ name, email }).catch(err =>
            console.error('Welcome email failed:', err.message)
        );

        res.json({ message: 'Account created successfully', user, tenant });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Registration failed — ' + err.message });
    }
});

// POST /login
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Wrong password' });

        const token = jwt.sign(
            { id: user._id, role: user.role, tenantId: user.tenantId },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({ token });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /change-password — logged in user changes own password
app.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Both fields required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect' });

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ message: 'Password updated successfully ✅' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /admin-reset-password — admin resets a tenant's password
app.post('/admin-reset-password', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { tenantId, newPassword } = req.body;

        if (!tenantId || !newPassword) {
            return res.status(400).json({ message: 'tenantId and newPassword required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const user = await User.findOne({ tenantId });
        if (!user) return res.status(404).json({ message: 'No user account found for this tenant' });

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ message: 'Password reset successfully ✅' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════
// FORGOT PASSWORD (3-step OTP flow)
// ═══════════════════════════════════════

// STEP 1 — POST /forgot-password
// Body: { email }
// Generates a 6-digit OTP, stores it in memory with 15min expiry, emails it
app.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email is required' });

        const user = await User.findOne({ email });
        if (!user) {
            // Return generic message — don't reveal whether email exists
            return res.json({ message: 'If this email exists, a reset code has been sent.' });
        }

        // Generate 6-digit code
        const code      = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

        // Store OTP
        otpStore.set(email, { code, expiresAt, name: user.name });

        // Send email
        await sendPasswordResetEmail({ name: user.name, email, code });

        res.json({ message: 'Reset code sent to your email 📧' });

    } catch (err) {
        console.error('Forgot password error:', err.message);
        res.status(500).json({ message: 'Failed to send reset code. Try again.' });
    }
});

// STEP 2 — POST /verify-reset-code
// Body: { email, code }
// Validates OTP without consuming it (so user can still reset password)
app.post('/verify-reset-code', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ message: 'Email and code are required' });

        const entry = otpStore.get(email);

        if (!entry) {
            return res.status(400).json({ message: 'No reset code found. Please request a new one.' });
        }

        if (Date.now() > entry.expiresAt) {
            otpStore.delete(email);
            return res.status(400).json({ message: 'Reset code has expired. Please request a new one.' });
        }

        if (entry.code !== code.toString()) {
            return res.status(400).json({ message: 'Invalid code. Please try again.' });
        }

        res.json({ message: 'Code verified ✅' });

    } catch (err) {
        res.status(500).json({ message: 'Verification failed. Try again.' });
    }
});

// STEP 3 — POST /reset-password-confirm
// Body: { email, code, newPassword }
// Verifies OTP again then resets password
app.post('/reset-password-confirm', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;

        if (!email || !code || !newPassword) {
            return res.status(400).json({ message: 'Email, code and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const entry = otpStore.get(email);

        if (!entry) {
            return res.status(400).json({ message: 'No reset code found. Please request a new one.' });
        }

        if (Date.now() > entry.expiresAt) {
            otpStore.delete(email);
            return res.status(400).json({ message: 'Reset code has expired. Please request a new one.' });
        }

        if (entry.code !== code.toString()) {
            return res.status(400).json({ message: 'Invalid code.' });
        }

        // Find and update user password
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        // Consume OTP — delete after successful reset
        otpStore.delete(email);

        res.json({ message: 'Password reset successfully ✅' });

    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ message: 'Password reset failed. Try again.' });
    }
});

// ═══════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════

// GET /tenant/:id
// GET /tenant/:id
app.get('/tenant/:id', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'tenant' && req.user.tenantId != req.params.id) {
            return res.status(403).json({ message: 'Forbidden' });
        if (req.user.role === 'tenant' && req.user.tenantId != req.params.id) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const tenant = await Tenant.findById(req.params.id).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const payments      = await Payment.find({ tenant: tenant._id });
        const totalPaid     = payments.reduce((sum, p) => sum + p.amount, 0);
        const rent          = tenant.house ? tenant.house.rent : 0;
        const monthsOccupied = payments.length > 0
            ? new Set(payments.map(p => p.month)).size
            : 1;
        const expectedTotal = rent * monthsOccupied;
        const arrears       = Math.max(0, expectedTotal - totalPaid);
        const arrears       = Math.max(0, expectedTotal - totalPaid);

        res.json({ tenant, payments, totalPaid, arrears });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /tenants — admin creates tenant record only (no user account)
app.post('/tenants', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = new Tenant(req.body);
        await tenant.save();
        res.status(201).json(tenant);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /tenants
// GET /tenants
app.get('/tenants', async (req, res) => {
    try {
        const tenants = await Tenant.find();
        res.json(tenants);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /tenants/:id
// PUT /tenants/:id
app.put('/tenants/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const updated = await Tenant.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /tenant/:id
app.delete('/tenant/:id', authMiddleware, adminOnly, async (req, res) => {
// DELETE /tenant/:id
app.delete('/tenant/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (tenant.house) {
            await House.findByIdAndUpdate(tenant.house, { status: 'available' });
            await House.findByIdAndUpdate(tenant.house, { status: 'available' });
        }

        await User.findOneAndDelete({ tenantId: req.params.id });
        await Tenant.findByIdAndDelete(req.params.id);

        res.json({ message: 'Tenant deleted ✅' });
        res.json({ message: 'Tenant deleted ✅' });

    } catch (err) {
        res.status(500).json({ message: 'Error deleting tenant ❌' });
        res.status(500).json({ message: 'Error deleting tenant ❌' });
    }
});

// ═══════════════════════════════════════
// HOUSES
// ═══════════════════════════════════════

// POST /houses
// POST /houses
app.post('/houses', authMiddleware, adminOnly, async (req, res) => {
    try {
        const house = new House(req.body);
        await house.save();
        res.status(201).json(house);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /houses
// GET /houses
app.get('/houses', async (req, res) => {
    try {
        const houses = await House.find();
        res.json(houses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /houses/:id
// PUT /houses/:id
app.put('/houses/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const updated = await House.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /house/:id
app.delete('/house/:id', authMiddleware, adminOnly, async (req, res) => {
// DELETE /house/:id
app.delete('/house/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const house = await House.findById(req.params.id);
        if (!house) return res.status(404).json({ message: 'House not found' });
        if (!house) return res.status(404).json({ message: 'House not found' });

        if (house.status === 'occupied') {
            return res.status(400).json({ message: 'Cannot delete occupied house 🚫' });
        if (house.status === 'occupied') {
            return res.status(400).json({ message: 'Cannot delete occupied house 🚫' });
        }

        await House.findByIdAndDelete(req.params.id);
        res.json({ message: 'House deleted 🏡' });
        res.json({ message: 'House deleted 🏡' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting house ❌' });
        res.status(500).json({ message: 'Error deleting house ❌' });
    }
});

// PUT /assign-house/:tenantId/:houseId
// PUT /assign-house/:tenantId/:houseId
app.put('/assign-house/:tenantId/:houseId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        const house  = await House.findById(req.params.houseId);

        if (!tenant || !house) {
            return res.status(404).json({ message: 'Tenant or House not found' });
            return res.status(404).json({ message: 'Tenant or House not found' });
        }

        if (house.status === 'occupied') {
            return res.status(400).json({ message: 'This house is already occupied ❌' });
        if (house.status === 'occupied') {
            return res.status(400).json({ message: 'This house is already occupied ❌' });
        }

        if (tenant.house) {
            return res.status(400).json({ message: 'Tenant already has a house assigned ❌' });
            return res.status(400).json({ message: 'Tenant already has a house assigned ❌' });
        }

        tenant.house = house._id;
        house.status = 'occupied';
        tenant.house = house._id;
        house.status = 'occupied';

        await tenant.save();
        await house.save();

        res.json({ message: 'House assigned successfully ✅', tenant, house });
        res.json({ message: 'House assigned successfully ✅', tenant, house });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /move-out/:tenantId
// PUT /move-out/:tenantId
app.put('/move-out/:tenantId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (!tenant.house) {
            return res.status(400).json({ message: 'This tenant is not assigned to any house' });
            return res.status(400).json({ message: 'This tenant is not assigned to any house' });
        }


        const house = await House.findById(tenant.house);
        if (!house) return res.status(404).json({ message: 'House not found' });

        // Send goodbye email BEFORE clearing house link
        sendMoveOutEmail({
            name:        tenant.name,
            email:       tenant.email,
            house:       house.name,
            moveOutDate: new Date()
        }).catch(err =>
            console.error('Move-out email failed:', err.message)
        );


        house.status = 'available';
        tenant.house = null;


        await house.save();
        await tenant.save();


        res.json({
            message: 'Tenant moved out successfully 🏠➡️🚪',
            message: 'Tenant moved out successfully 🏠➡️🚪',
            tenant,
            house
        });


    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════

// POST /payments — admin records manual payment + emails PDF receipt via Resend
app.post('/payments', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { tenantId, amount, month } = req.body;

        const tenant = await Tenant.findById(tenantId).populate('house');
        if (!tenant)       return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house' });
        if (!tenant)       return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house' });

        const existingPayment = await Payment.findOne({ tenant: tenantId, month });
        if (existingPayment) {
            return res.status(400).json({ message: 'Payment for this month already exists ❌' });
            return res.status(400).json({ message: 'Payment for this month already exists ❌' });
        }

        const payment = new Payment({
            tenant: tenant._id,
            house:  tenant.house._id,
            amount,
            month,
            status: 'paid'
        });

        await payment.save();

        // Generate PDF receipt
        const doc     = new PDFDocument();
        const buffers = [];
        const buffers = [];

        doc.on('data', chunk => buffers.push(chunk));
        doc.on('data', chunk => buffers.push(chunk));

        doc.fontSize(20).text('RENT RECEIPT', { align: 'center' });
        doc.fontSize(20).text('RENT RECEIPT', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Tenant: ${tenant.name}`);
        doc.text(`House:  ${tenant.house.name}`);
        doc.text(`Amount: Ksh ${amount}`);
        doc.text(`Month:  ${month}`);
        doc.text(`Date:   ${new Date().toDateString()}`);
        doc.text(`Receipt ID: ${payment._id}`);
        doc.moveDown();
        doc.text('Thank you for your payment — Affordable Rentals');
        doc.end();

        doc.on('end', async () => {
            const pdfBuffer = Buffer.concat(buffers);

            // Send receipt email via Resend with PDF attachment
            try {
                const { Resend } = require('resend');
                const resend = new Resend(process.env.RESEND_API_KEY);

                await resend.emails.send({
                    from:    'Affordable Rentals 🏠 <support@affordablerentals.site>',
                    to:      tenant.email,
                    subject: `Rent Receipt — ${month} | ${tenant.house.name}`,
                    html: `
                    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                      <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:32px;text-align:center">
                        <div style="font-size:40px;margin-bottom:8px">🧾</div>
                        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Rent Receipt</h1>
                        <p style="color:#bae6fd;margin:6px 0 0;font-size:13px">${month}</p>
                      </div>
                      <div style="padding:32px">
                        <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${tenant.name.split(' ')[0]}</strong>,</p>
                        <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">
                          Your rent payment for <strong>${month}</strong> has been recorded. Please find your receipt attached as a PDF.
                        </p>
                        <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px 24px;margin-bottom:24px">
                          <table style="width:100%;border-collapse:collapse">
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Tenant</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${tenant.name}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">House</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${tenant.house.name}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Month</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${month}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Amount</td><td style="color:#1d4ed8;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(amount).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Status</td><td style="text-align:right"><span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">Paid ✓</span></td></tr>
                          </table>
                        </div>
                        <p style="color:#94a3b8;font-size:12px;margin:0">Thank you for your payment. Contact us at <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a> if you have any questions.</p>
                      </div>
                      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center">
                        <p style="color:#cbd5e1;font-size:11px;margin:0">© ${new Date().getFullYear()} Affordable Rentals · <a href="https://affordablerentals.site" style="color:#94a3b8;text-decoration:none">affordablerentals.site</a></p>
                      </div>
                    </div>`,
                    attachments: [{
                        filename: `receipt-${payment._id}.pdf`,
                        content:  pdfData.toString('base64')
                    }]
                });

                console.log(`📧 Receipt email sent to ${tenant.email}`);

            } catch (emailErr) {
                console.error('Receipt email failed:', emailErr.message);
                // Don't fail the request — payment is already saved
            }

            res.json({
                message:   'Payment saved + PDF emailed 📧📄',
                message:   'Payment saved + PDF emailed 📧📄',
                paymentId: payment._id,
                payment
            });
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /payments
// GET /payments
app.get('/payments', async (req, res) => {
    try {
        const payments = await Payment.find().populate('tenant').populate('house');
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /payments/tenant/:tenantId
// GET /payments/tenant/:tenantId
app.get('/payments/tenant/:tenantId', async (req, res) => {
    try {
        const payments = await Payment.find({ tenant: req.params.tenantId });
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// RECEIPTS
// ═══════════════════════════════════════

// GET /receipt/:paymentId — JSON
app.get('/receipt/:paymentId', async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: 'Payment not found' });
        res.json(payment);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /receipt/pdf/:paymentId — PDF download
app.get('/receipt/pdf/:paymentId', async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: 'Payment not found' });
        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        const doc = new PDFDocument();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=receipt-${payment._id}.pdf`);

        doc.pipe(res);

        doc.fontSize(20).text('RENT RECEIPT', { align: 'center' });
        doc.fontSize(20).text('RENT RECEIPT', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Tenant: ${payment.tenant.name}`);
        doc.text(`House:  ${payment.house.name}`);
        doc.text(`Amount Paid: Ksh ${payment.amount}`);
        doc.text(`Month:  ${payment.month}`);
        doc.text(`Date:   ${payment.datePaid.toDateString()}`);
        doc.text(`Receipt ID: ${payment._id}`);
        doc.moveDown();
        doc.text('Thank you for your payment — Affordable Rentals');

        doc.end();

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// ARREARS
// ═══════════════════════════════════════

// GET /arrears
app.get('/arrears', async (req, res) => {
    try {
        const tenants     = await Tenant.find().populate('house');
        const arrearsList = [];
        const arrearsList = [];

        for (const tenant of tenants) {
        for (const tenant of tenants) {
            if (!tenant.house) continue;

            const rent      = tenant.house.rent;
            const payments  = await Payment.find({ tenant: tenant._id });
            const rent      = tenant.house.rent;
            const payments  = await Payment.find({ tenant: tenant._id });
            const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
            const arrears   = Math.max(0, rent - totalPaid);
            const arrears   = Math.max(0, rent - totalPaid);

            if (arrears > 0) {
                arrearsList.push({
                    tenant: tenant.name,
                    house:  tenant.house.name,
                    rent,
                    paid:   totalPaid,
                    arrears
                });
            }
        }

        res.json(arrearsList);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /arrears/:month
app.get('/arrears/:month', async (req, res) => {
    try {
        const month   = req.params.month;
        const tenants = await Tenant.find().populate('house');
        const result  = [];
        const result  = [];

        for (const tenant of tenants) {
        for (const tenant of tenants) {
            if (!tenant.house) continue;

            const rent    = tenant.house.rent;
            const payment = await Payment.findOne({ tenant: tenant._id, month });
            const paid    = payment ? payment.amount : 0;
            const arrears = Math.max(0, rent - paid);
            const arrears = Math.max(0, rent - paid);

            if (arrears > 0) {
                result.push({
                    tenant: tenant.name,
                    house:  tenant.house.name,
                    month,
                    rent,
                    paid,
                    arrears
                });
            }
        }

        res.json(result);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════

// GET /dashboard/:month
// GET /dashboard/:month
app.get('/dashboard/:month', authMiddleware, adminOnly, async (req, res) => {
    try {
        const month    = req.params.month;
        const tenants  = await Tenant.find().populate('house');
        const houses   = await House.find();
        const payments = await Payment.find({ month });

        let totalIncome  = 0;
        let totalArrears = 0;
        let occupied     = 0;

        payments.forEach(p => { totalIncome += p.amount; });
        houses.forEach(h => { if (h.status === 'occupied') occupied++; });
        houses.forEach(h => { if (h.status === 'occupied') occupied++; });

        for (const tenant of tenants) {
        for (const tenant of tenants) {
            if (!tenant.house) continue;

            const rent    = tenant.house.rent;
            const payment = payments.find(p => p.tenant.toString() === tenant._id.toString());
            const paid    = payment ? payment.amount : 0;
            const arrears = Math.max(0, rent - paid);
            const arrears = Math.max(0, rent - paid);

            if (arrears > 0) totalArrears += arrears;
        }

        res.json({
            month,
            totalIncome,
            totalArrears,
            totalTenants:   tenants.length,
            totalHouses:    houses.length,
            totalTenants:   tenants.length,
            totalHouses:    houses.length,
            occupiedHouses: occupied,
            vacantHouses:   houses.length - occupied
            vacantHouses:   houses.length - occupied
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// STK PUSH (M-PESA)
// ═══════════════════════════════════════

// POST /stkpush
app.post('/stkpush', authMiddleware, async (req, res) => {
    try {
        const { phone, amount, month } = req.body;

        if (!phone || !amount || !month) {
            return res.status(400).json({ message: 'phone, amount and month are required' });
        }

        let payPhone = phone;
        if (req.user.role === 'tenant') {
            const tenant = await Tenant.findById(req.user.tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            payPhone = tenant.phone;
        }

        const token     = await getToken();
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password  = Buffer.from(
            process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
        ).toString('base64');

        const stkRes = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: process.env.MPESA_SHORTCODE,
                Password:          password,
                Timestamp:         timestamp,
                TransactionType:   'CustomerPayBillOnline',
                Amount:            amount,
                PartyA:            payPhone,
                PartyB:            process.env.MPESA_SHORTCODE,
                PhoneNumber:       payPhone,
                CallBackURL:       process.env.MPESA_CALLBACK_URL,
                AccountReference:  `Rent-${month}`,
                TransactionDesc:   `Rent payment for ${month}`
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = stkRes.data;

        if (data.ResponseCode !== '0') {
            return res.status(400).json({
                message: data.ResponseDescription || 'STK push failed',
                data
            });
        }

        // Save a pending payment record
        const tenantId = req.user.tenantId || req.body.tenantId;
        const tenant   = await Tenant.findById(tenantId).populate('house');

        if (tenant && tenant.house) {
            await Payment.create({
                tenant:            tenant._id,
                house:             tenant.house._id,
                amount,
                month,
                status:            'pending',
                checkoutRequestId: data.CheckoutRequestID,
                merchantRequestId: data.MerchantRequestID
            });
        }

        res.json({
            message:           'M-Pesa prompt sent to your phone 📱',
            checkoutRequestId: data.CheckoutRequestID,
            merchantRequestId: data.MerchantRequestID
        });

    } catch (err) {
        console.error('🔥 STK Push error:', err.response?.data || err.message);
        res.status(500).json({
            error:   'STK Push failed',
            details: err.response?.data || err.message
        });
    }
});

// POST /callback — Safaricom calls this after payment
app.post('/callback', async (req, res) => {
    // Always respond 200 immediately
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    try {
        const body     = req.body;
        const stk      = body?.Body?.stkCallback;
        if (!stk) return;

        const checkoutRequestId = stk.CheckoutRequestID;
        const resultCode        = stk.ResultCode;

        // Find the pending payment
        const payment = await Payment.findOne({ checkoutRequestId }).populate('tenant').populate('house');
        if (!payment) {
            console.log('Callback: no pending payment found for', checkoutRequestId);
            return;
        }

        if (resultCode === 0) {
            // Payment successful
            const items   = stk.CallbackMetadata?.Item || [];
            const getItem = name => items.find(i => i.Name === name)?.Value;

            payment.status    = 'paid';
            payment.mpesaCode = getItem('MpesaReceiptNumber') || '';
            payment.datePaid  = new Date();
            await payment.save();

            console.log(`✅ Payment confirmed: ${payment.mpesaCode} for ${payment.month}`);

            // Send receipt email — non-blocking
            if (payment.tenant && payment.house) {
                const { Resend } = require('resend');
                const resend = new Resend(process.env.RESEND_API_KEY);

                resend.emails.send({
                    from:    'Affordable Rentals 🏠 <support@affordablerentals.site>',
                    to:      payment.tenant.email,
                    subject: `✅ Payment Confirmed — ${payment.month} | ${payment.house.name}`,
                    html: `
                    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                      <div style="background:linear-gradient(135deg,#16a34a,#15803d);padding:32px;text-align:center">
                        <div style="font-size:40px;margin-bottom:8px">✅</div>
                        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Payment Confirmed</h1>
                        <p style="color:#bbf7d0;margin:6px 0 0;font-size:13px">${payment.month}</p>
                      </div>
                      <div style="padding:32px">
                        <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${payment.tenant.name.split(' ')[0]}</strong>,</p>
                        <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">Your M-Pesa payment has been received and confirmed. Here are your payment details:</p>
                        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;margin-bottom:24px">
                          <table style="width:100%;border-collapse:collapse">
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">House</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${payment.house.name}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Month</td><td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${payment.month}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Amount</td><td style="color:#16a34a;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(payment.amount).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">M-Pesa Code</td><td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right;font-family:monospace">${payment.mpesaCode}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Status</td><td style="text-align:right"><span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">Paid ✓</span></td></tr>
                          </table>
                        </div>
                        <p style="color:#94a3b8;font-size:12px;margin:0">Keep this email as your receipt. Contact us at <a href="mailto:support@affordablerentals.site" style="color:#16a34a">support@affordablerentals.site</a> if you have any questions.</p>
                      </div>
                      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center">
                        <p style="color:#cbd5e1;font-size:11px;margin:0">© ${new Date().getFullYear()} Affordable Rentals · <a href="https://affordablerentals.site" style="color:#94a3b8;text-decoration:none">affordablerentals.site</a></p>
                      </div>
                    </div>`
                }).catch(err => console.error('Confirmation email failed:', err.message));
            }

        } else {
            // Payment failed or cancelled
            payment.status = 'failed';
            await payment.save();
            console.log(`❌ Payment failed for ${checkoutRequestId} — ResultCode: ${resultCode}`);
        }

    } catch (err) {
        console.error('Callback processing error:', err.message);
    }
});

// GET /payment-status/:checkoutRequestId
app.get('/payment-status/:checkoutRequestId', authMiddleware, async (req, res) => {
    try {
        const payment = await Payment.findOne({
            checkoutRequestId: req.params.checkoutRequestId
        });

        if (!payment) return res.status(404).json({ status: 'not_found' });

        res.json({
            status:    payment.status,
            paymentId: payment._id,
            mpesaCode: payment.mpesaCode || null,
            amount:    payment.amount,
            month:     payment.month
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /stk-query — manual fallback query to Safaricom
app.post('/stk-query', authMiddleware, async (req, res) => {
    try {
        const { checkoutRequestId } = req.body;
        if (!checkoutRequestId) return res.status(400).json({ message: 'checkoutRequestId required' });

        const token     = await getToken();
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password  = Buffer.from(
            process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
        ).toString('base64');

        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
            {
                BusinessShortCode: process.env.MPESA_SHORTCODE,
                Password:          password,
                Timestamp:         timestamp,
                CheckoutRequestID: checkoutRequestId
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = response.data;

        res.json({
            resultCode: data.ResultCode,
            resultDesc: data.ResultDesc,
            success:    data.ResultCode === '0' || data.ResultCode === 0
        });

    } catch (err) {
        res.status(500).json({
            error:   'STK query failed',
            details: err.response?.data || err.message
        });
    }
});

// ═══════════════════════════════════════
// CRON — RENT REMINDERS (runs daily 9AM)
// ═══════════════════════════════════════

async function checkArrears() {
    const today      = new Date();
    const currentDay = today.getDate();
    const month      = today.toLocaleString('default', { month: 'long', year: 'numeric' });


    console.log(`🕘 Running rent check for ${month}...`);


    try {
        const tenants = await Tenant.find().populate('house');

        for (const tenant of tenants) {
            if (!tenant.house)                   continue;
            if (currentDay < tenant.dueDate)     continue;

            const paid = await Payment.findOne({ tenant: tenant._id, month, status: 'paid' });

            if (!paid) {
                const arrears = Math.max(0, tenant.house.rent);

                const arrears = Math.max(0, tenant.house.rent);

                console.log(`⚠️  ${tenant.name} has not paid for ${month} — Ksh ${arrears} owed`);


                sendRentReminder({
                    name:    tenant.name,
                    email:   tenant.email,
                    house:   tenant.house.name,
                    rent:    tenant.house.rent,
                    name:    tenant.name,
                    email:   tenant.email,
                    house:   tenant.house.name,
                    rent:    tenant.house.rent,
                    month,
                    dueDate: tenant.dueDate,
                    dueDate: tenant.dueDate,
                    arrears
                }).catch(err =>
                    console.error(`Reminder email failed for ${tenant.name}:`, err.message)
                );
            }
        }


        console.log('✅ Rent check complete');


    } catch (err) {
        console.error('checkArrears error:', err.message);
    }
}

cron.schedule('0 9 * * *', () => { checkArrears(); });

// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

app.post('/rules', authMiddleware, adminOnly, async (req, res) => {
    try {
        const rule = await Rule.create(req.body);
        res.json(rule);
    } catch (err) {
        res.status(500).json({ message: 'Error adding rule' });
        res.status(500).json({ message: 'Error adding rule' });
    }
});

app.get('/rules', async (req, res) => {
    try {
        const rules = await Rule.find().sort({ createdAt: -1 });
        res.json(rules);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching rules' });
        res.status(500).json({ message: 'Error fetching rules' });
    }
});

app.delete('/rules/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const rule = await Rule.findByIdAndDelete(req.params.id);
        if (!rule) return res.status(404).json({ message: 'Rule not found' });
        res.json({ message: 'Rule deleted ✅' });
        if (!rule) return res.status(404).json({ message: 'Rule not found' });
        res.json({ message: 'Rule deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting rule' });
        res.status(500).json({ message: 'Error deleting rule' });
    }
});

// ═══════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════
// ═══════════════════════════════════════

app.post('/announcements', authMiddleware, adminOnly, async (req, res) => {
    try {
        const a = await Announcement.create(req.body);
        res.json(a);
    } catch (err) {
        res.status(500).json({ message: 'Error creating announcement' });
        res.status(500).json({ message: 'Error creating announcement' });
    }
});

app.get('/announcements', async (req, res) => {
    try {
        const list = await Announcement.find().sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching announcements' });
        res.status(500).json({ message: 'Error fetching announcements' });
    }
});

app.delete('/announcements/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const a = await Announcement.findByIdAndDelete(req.params.id);
        if (!a) return res.status(404).json({ message: 'Announcement not found' });
        res.json({ message: 'Announcement deleted ✅' });
        if (!a) return res.status(404).json({ message: 'Announcement not found' });
        res.json({ message: 'Announcement deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting announcement' });
        res.status(500).json({ message: 'Error deleting announcement' });
    }
});

// ═══════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════

// POST /messages — tenant sends
app.post('/messages', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ message: 'Message text is required' });

        const msg = await Message.create({
            tenant: req.user.tenantId,
            sender: 'tenant',
            tenant: req.user.tenantId,
            sender: 'tenant',
            text:   text.trim(),
            isRead: false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: 'Error sending message' });
        res.status(500).json({ message: 'Error sending message' });
    }
});

// POST /messages/reply — admin replies
app.post('/messages/reply', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { tenantId, text } = req.body;
        if (!tenantId || !text || !text.trim()) {
            return res.status(400).json({ message: 'tenantId and text are required' });
            return res.status(400).json({ message: 'tenantId and text are required' });
        }

        const msg = await Message.create({
            tenant: tenantId,
            sender: 'admin',
            tenant: tenantId,
            sender: 'admin',
            text:   text.trim(),
            isRead: false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: 'Error sending reply' });
        res.status(500).json({ message: 'Error sending reply' });
    }
});

// GET /messages/my — tenant's thread
app.get('/messages/my', authMiddleware, async (req, res) => {
    try {
        const messages = await Message.find({ tenant: req.user.tenantId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching messages' });
        res.status(500).json({ message: 'Error fetching messages' });
    }
});

// GET /messages/thread/:tenantId — admin view
app.get('/messages/thread/:tenantId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const messages = await Message.find({ tenant: req.params.tenantId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching thread' });
        res.status(500).json({ message: 'Error fetching thread' });
    }
});

// PUT /messages/read/:tenantId
app.put('/messages/read/:tenantId', authMiddleware, adminOnly, async (req, res) => {
    try {
        await Message.updateMany(
            { tenant: req.params.tenantId, sender: 'tenant', isRead: false },
            { tenant: req.params.tenantId, sender: 'tenant', isRead: false },
            { isRead: true }
        );
        res.json({ message: 'Marked as read' });
        res.json({ message: 'Marked as read' });
    } catch (err) {
        res.status(500).json({ message: 'Error marking as read' });
        res.status(500).json({ message: 'Error marking as read' });
    }
});

// GET /messages/unread — admin badge counts
app.get('/messages/unread', authMiddleware, adminOnly, async (req, res) => {
    try {
        const unread = await Message.aggregate([
            { $match: { sender: 'tenant', isRead: false } },
            { $group: { _id: '$tenant', count: { $sum: 1 } } }
            { $match: { sender: 'tenant', isRead: false } },
            { $group: { _id: '$tenant', count: { $sum: 1 } } }
        ]);
        res.json(unread);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching unread messages' });
        res.status(500).json({ message: 'Error fetching unread messages' });
    }
});

// GET /messages/unread-mine — tenant unread count
app.get('/messages/unread-mine', authMiddleware, async (req, res) => {
    try {
        const count = await Message.countDocuments({
            tenant: req.user.tenantId,
            sender: 'admin',
            sender: 'admin',
            isRead: false
        });
        res.json({ count });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching unread count' });
        res.status(500).json({ message: 'Error fetching unread count' });
    }
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT} 🚀`);
});