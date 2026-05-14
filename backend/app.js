const express = require('express');
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
const Tenant              = require('./models/Tenant');
const House               = require('./models/House');
const Payment             = require('./models/Payment');
const User                = require('./models/User');
const Rule                = require('./models/Rule');
const Announcement        = require('./models/Announcement');
const Message             = require('./models/Message');
const Settings            = require('./models/Settings');
const SubscriptionPlan    = require('./models/SubscriptionPlan');
const SubscriptionPayment = require('./models/SubscriptionPayment');

// ── DB ──
const connectDB = require('./db');
connectDB();

// ── In-memory OTP store { email: { code, expiresAt, name } } ──
// For production scale, replace with Redis
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

// ── FIX 3: Apply subscription guard to admin-only routes ──
// Tenants bypass entirely. Admins in grace get a warning header but still proceed.
async function checkSubscription(req, res, next) {
    if (req.user.role !== 'admin') return next();

    try {
        const admin = await User.findById(req.user.id).select(
            'subscriptionStatus subscriptionExpiry trialEndsAt gracePeriodUntil suspendedReason'
        );

        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        const now = new Date();

        // Auto-advance status based on dates
        if (admin.subscriptionStatus === 'trial' && admin.trialEndsAt && now > admin.trialEndsAt) {
            admin.subscriptionStatus = 'expired';
            admin.gracePeriodUntil   = null;
            await admin.save();
        }

        if (admin.subscriptionStatus === 'active' && admin.subscriptionExpiry && now > admin.subscriptionExpiry) {
            admin.subscriptionStatus = 'grace';
            admin.gracePeriodUntil   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            await admin.save();
        }

        if (admin.subscriptionStatus === 'grace' && admin.gracePeriodUntil && now > admin.gracePeriodUntil) {
            admin.subscriptionStatus = 'expired';
            await admin.save();
        }

        switch (admin.subscriptionStatus) {
            case 'trial':
            case 'active':
                return next();

            case 'grace':
                req.subscriptionWarning = {
                    status:  'grace',
                    message: `Your subscription has expired. You have until ${admin.gracePeriodUntil.toDateString()} to renew before losing access.`,
                    until:   admin.gracePeriodUntil
                };
                return next();

            case 'expired':
                return res.status(403).json({
                    message:            'Subscription expired. Please renew to continue.',
                    subscriptionStatus: 'expired',
                    code:               'SUBSCRIPTION_EXPIRED'
                });

            case 'suspended':
                return res.status(403).json({
                    message:            `Your account has been suspended. Reason: ${admin.suspendedReason || 'Contact support.'}`,
                    subscriptionStatus: 'suspended',
                    code:               'ACCOUNT_SUSPENDED'
                });

            default:
                return res.status(403).json({ message: 'Subscription status unknown.' });
        }
    } catch (err) {
        console.error('checkSubscription error:', err.message);
        next(); // fail open — never lock out on DB error
    }
}

// ── Stacklord key auth ──
function stacklordAuth(req, res, next) {
    const key = req.headers['x-stacklord-key'] || req.query.key;
    if (!key || key !== process.env.STACKLORD_KEY) {
        return res.status(401).json({ message: 'Unauthorized — Stacklord access only 🔒' });
    }
    next();
}


// ═══════════════════════════════════════
// M-PESA HELPERS
// ═══════════════════════════════════════

// Rent payments — uses landlord's Paybill credentials
async function getRentToken() {
    const auth = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const res = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
    );
    return res.data.access_token;
}

// Subscription payments — uses platform's own credentials
async function getSystemToken() {
    const auth = Buffer.from(
        `${process.env.SYSTEM_CONSUMER_KEY}:${process.env.SYSTEM_CONSUMER_SECRET}`
    ).toString('base64');

    const res = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
    );
    return res.data.access_token;
}

// ── Keep legacy alias so nothing inside breaks ──
const getToken = getRentToken;


// ═══════════════════════════════════════
// MAINTENANCE MODE
// ═══════════════════════════════════════

// GET /maintenance — public (tenants check this on load)
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

// PUT /maintenance — admin only
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
// AUTH
// ═══════════════════════════════════════

// POST /register — creates a tenant user + tenant record
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

        const tenant = await Tenant.create({ name, email, phone, dueDate: dueDate || 5 });

        const user = await User.create({
            name,
            email,
            password: hashedPassword,
            role:     'tenant',
            tenantId: tenant._id
        });

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

        // FIX: block suspended admins at login
        if (user.role === 'admin' && user.subscriptionStatus === 'suspended') {
            return res.status(403).json({
                message: `Your account has been suspended. Reason: ${user.suspendedReason || 'Contact support.'}`,
                code:    'ACCOUNT_SUSPENDED'
            });
        }

        const token = jwt.sign(
            { id: user._id, role: user.role, tenantId: user.tenantId },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ token });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /change-password — logged-in user changes own password
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

// POST /reset-password — FIX 2 & 13: renamed to match script.js call
// Admin resets a tenant's password by tenantId
app.post('/reset-password', authMiddleware, adminOnly, async (req, res) => {
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
app.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email is required' });

        const user = await User.findOne({ email });
        if (!user) {
            return res.json({ message: 'If this email exists, a reset code has been sent.' });
        }

        const code      = crypto.randomInt(100000, 999999).toString();
        const expiresAt = Date.now() + 15 * 60 * 1000;

        otpStore.set(email, { code, expiresAt, name: user.name });

        await sendPasswordResetEmail({ name: user.name, email, code });

        res.json({ message: 'Reset code sent to your email 📧' });

    } catch (err) {
        console.error('Forgot password error:', err.message);
        res.status(500).json({ message: 'Failed to send reset code. Try again.' });
    }
});

// STEP 2 — POST /verify-reset-code
app.post('/verify-reset-code', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ message: 'Email and code are required' });

        const entry = otpStore.get(email);
        if (!entry) return res.status(400).json({ message: 'No reset code found. Please request a new one.' });
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
        if (!entry) return res.status(400).json({ message: 'No reset code found. Please request a new one.' });
        if (Date.now() > entry.expiresAt) {
            otpStore.delete(email);
            return res.status(400).json({ message: 'Reset code has expired.' });
        }
        if (entry.code !== code.toString()) {
            return res.status(400).json({ message: 'Invalid code.' });
        }

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

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

// GET /tenant/:id — tenant sees own data; admin sees any
app.get('/tenant/:id', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'tenant' && String(req.user.tenantId) !== req.params.id) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const tenant = await Tenant.findById(req.params.id).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const payments      = await Payment.find({ tenant: tenant._id, status: { $in: ['paid', 'partial'] } });
        const totalPaid     = payments.reduce((sum, p) => sum + p.amount, 0);
        const rent          = tenant.house ? tenant.house.rent : 0;
        const months        = new Set(payments.map(p => p.month)).size || 1;
        const expectedTotal = rent * months;
        const arrears       = Math.max(0, expectedTotal - totalPaid);

        res.json({ tenant, payments, totalPaid, arrears });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /tenants — FIX 1: auth required; admin gets all, tenant gets own record only
app.get('/tenants', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'admin') {
            const tenants = await Tenant.find().populate('house');
            return res.json(tenants);
        }
        // Tenant: return only their own record
        const tenant = await Tenant.findById(req.user.tenantId).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        return res.json([tenant]);
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

// PUT /tenants/:id — admin only
app.put('/tenants/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const updated = await Tenant.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /tenant/:id — admin only
app.delete('/tenant/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (tenant.house) {
            await House.findByIdAndUpdate(tenant.house, { status: 'available' });
        }

        await User.findOneAndDelete({ tenantId: req.params.id });
        await Tenant.findByIdAndDelete(req.params.id);

        res.json({ message: 'Tenant deleted ✅' });

    } catch (err) {
        res.status(500).json({ message: 'Error deleting tenant ❌' });
    }
});


// ═══════════════════════════════════════
// HOUSES
// ═══════════════════════════════════════

// POST /houses — admin only
app.post('/houses', authMiddleware, adminOnly, async (req, res) => {
    try {
        const house = new House(req.body);
        await house.save();
        res.status(201).json(house);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /houses — FIX 1: auth required
// Admin sees all; tenant sees only their assigned house
app.get('/houses', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'admin') {
            const houses = await House.find();
            return res.json(houses);
        }
        // Tenant: return only their house
        const tenant = await Tenant.findById(req.user.tenantId).populate('house');
        if (!tenant || !tenant.house) return res.json([]);
        return res.json([tenant.house]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /houses/:id — admin only
app.put('/houses/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const updated = await House.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /house/:id — admin only, cannot delete occupied house
app.delete('/house/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const house = await House.findById(req.params.id);
        if (!house) return res.status(404).json({ message: 'House not found' });

        if (house.status === 'occupied') {
            return res.status(400).json({ message: 'Cannot delete occupied house 🚫' });
        }

        await House.findByIdAndDelete(req.params.id);
        res.json({ message: 'House deleted 🏡' });

    } catch (err) {
        res.status(500).json({ message: 'Error deleting house ❌' });
    }
});

// PUT /assign-house/:tenantId/:houseId — admin only
app.put('/assign-house/:tenantId/:houseId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        const house  = await House.findById(req.params.houseId);

        if (!tenant || !house) {
            return res.status(404).json({ message: 'Tenant or House not found' });
        }
        if (house.status === 'occupied') {
            return res.status(400).json({ message: 'This house is already occupied ❌' });
        }
        if (tenant.house) {
            return res.status(400).json({ message: 'Tenant already has a house assigned ❌' });
        }

        tenant.house = house._id;
        house.status = 'occupied';

        await tenant.save();
        await house.save();

        res.json({ message: 'House assigned successfully ✅', tenant, house });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /move-out/:tenantId — admin only
app.put('/move-out/:tenantId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'This tenant is not assigned to any house' });

        const house = await House.findById(tenant.house);
        if (!house) return res.status(404).json({ message: 'House not found' });

        sendMoveOutEmail({
            name:        tenant.name,
            email:       tenant.email,
            house:       house.name,
            moveOutDate: new Date()
        }).catch(err => console.error('Move-out email failed:', err.message));

        house.status = 'available';
        tenant.house = null;

        await house.save();
        await tenant.save();

        res.json({ message: 'Tenant moved out successfully 🏠➡️🚪', tenant, house });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// PAYMENT HELPER
// ═══════════════════════════════════════

// Returns { rentAmount, totalPaid, balance, status, payments[] }
async function getMonthSummary(tenantId, month, rent) {
    const payments = await Payment.find({
        tenant: tenantId,
        month,
        status: { $in: ['paid', 'partial'] }
    }).sort({ createdAt: 1 });

    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const balance   = Math.max(0, rent - totalPaid);

    let status = 'unpaid';
    if (totalPaid >= rent)  status = 'paid';
    else if (totalPaid > 0) status = 'partial';

    return { rentAmount: rent, totalPaid, balance, status, payments };
}


// ═══════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════

// POST /payments — FIX 3: admin + checkSubscription
// Admin records a manual payment
app.post('/payments', authMiddleware, adminOnly, checkSubscription, async (req, res) => {
    try {
        const { tenantId, amount, month, method = 'cash', note = '' } = req.body;

        if (!tenantId || !amount || !month) {
            return res.status(400).json({ message: 'tenantId, amount and month are required' });
        }
        if (amount <= 0) {
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        const tenant = await Tenant.findById(tenantId).populate('house');
        if (!tenant)       return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house assigned' });

        const rent    = tenant.house.rent;
        const summary = await getMonthSummary(tenantId, month, rent);

        if (summary.status === 'paid') {
            return res.status(400).json({
                message: `Rent for ${month} is already fully paid ✅`,
                summary
            });
        }

        if (amount > summary.balance) {
            return res.status(400).json({
                message: `Overpayment detected. Balance remaining is Ksh ${summary.balance}.`,
                balance: summary.balance,
                summary
            });
        }

        const newTotalPaid = summary.totalPaid + amount;
        const newBalance   = Math.max(0, rent - newTotalPaid);
        const newStatus    = newBalance === 0 ? 'paid' : 'partial';

        const payment = await Payment.create({
            tenant:     tenant._id,
            house:      tenant.house._id,
            amount,
            month,
            rentAmount: rent,
            totalPaid:  newTotalPaid,
            balance:    newBalance,
            status:     newStatus,
            method,
            note,
            datePaid:   new Date()
        });

        // Generate PDF receipt
        const doc     = new PDFDocument();
        const buffers = [];
        doc.on('data', chunk => buffers.push(chunk));

        doc.fontSize(20).text('RENT RECEIPT', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Tenant:       ${tenant.name}`);
        doc.text(`House:        ${tenant.house.name}`);
        doc.text(`Month:        ${month}`);
        doc.text(`This Payment: Ksh ${Number(amount).toLocaleString()}`);
        doc.text(`Total Paid:   Ksh ${Number(newTotalPaid).toLocaleString()}`);
        doc.text(`Rent Amount:  Ksh ${Number(rent).toLocaleString()}`);
        doc.text(`Balance:      Ksh ${Number(newBalance).toLocaleString()}`);
        doc.text(`Status:       ${newStatus.toUpperCase()}`);
        doc.text(`Date:         ${new Date().toDateString()}`);
        doc.text(`Receipt ID:   ${payment._id}`);
        doc.moveDown();
        doc.text('Thank you for your payment — Affordable Rentals');
        doc.end();

        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);

            try {
                const { Resend } = require('resend');
                const resend     = new Resend(process.env.RESEND_API_KEY);

                const statusColor = newStatus === 'paid' ? '#16a34a' : '#d97706';
                const statusLabel = newStatus === 'paid' ? 'Fully Paid ✓' : 'Partial Payment';
                const statusBg    = newStatus === 'paid' ? '#dcfce7' : '#fef3c7';

                await resend.emails.send({
                    from:    'Affordable Rentals 🏠 <support@affordablerentals.site>',
                    to:      tenant.email,
                    subject: `${newStatus === 'paid' ? '✅' : '🔔'} Rent Receipt — ${month} | ${tenant.house.name}`,
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
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">House</td>              <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${tenant.house.name}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Month</td>              <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${month}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Monthly Rent</td>       <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">Ksh ${Number(rent).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">This Payment</td>       <td style="color:#1d4ed8;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(amount).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Total Paid</td>         <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">Ksh ${Number(newTotalPaid).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Balance Remaining</td>  <td style="color:${newBalance > 0 ? '#d97706' : '#16a34a'};font-size:13px;font-weight:700;text-align:right">Ksh ${Number(newBalance).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Status</td>             <td style="text-align:right"><span style="background:${statusBg};color:${statusColor};font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">${statusLabel}</span></td></tr>
                          </table>
                        </div>
                        ${newBalance > 0 ? `
                        <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:20px">
                          <p style="color:#92400e;font-size:13px;margin:0">⚠️ You still have a balance of <strong>Ksh ${Number(newBalance).toLocaleString()}</strong> for ${month}. Please pay before your due date.</p>
                        </div>` : ''}
                        <p style="color:#94a3b8;font-size:12px;margin:0">PDF receipt is attached. Contact us at <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a> for queries.</p>
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
            }

            res.json({
                message:   `Payment recorded — ${newStatus.toUpperCase()} 📄`,
                paymentId: payment._id,
                payment,
                summary: { rentAmount: rent, totalPaid: newTotalPaid, balance: newBalance, status: newStatus }
            });
        });

    } catch (err) {
        console.error('Payment error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /payments — FIX 1: admin only
app.get('/payments', authMiddleware, adminOnly, async (req, res) => {
    try {
        const payments = await Payment.find()
            .populate('tenant')
            .populate('house')
            .sort({ createdAt: -1 });
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /payments/tenant/:tenantId — FIX 1: auth required; tenant sees own only
app.get('/payments/tenant/:tenantId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'tenant' && String(req.user.tenantId) !== req.params.tenantId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const payments = await Payment.find({ tenant: req.params.tenantId })
            .sort({ createdAt: -1 });
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /payments/summary/:tenantId/:month — auth required, tenant sees own only
app.get('/payments/summary/:tenantId/:month', authMiddleware, async (req, res) => {
    try {
        const { tenantId, month } = req.params;

        if (req.user.role === 'tenant' && String(req.user.tenantId) !== tenantId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const tenant = await Tenant.findById(tenantId).populate('house');
        if (!tenant)       return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house' });

        const summary = await getMonthSummary(tenantId, month, tenant.house.rent);
        res.json(summary);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /payments/months/:tenantId — auth required, tenant sees own only
app.get('/payments/months/:tenantId', authMiddleware, async (req, res) => {
    try {
        const { tenantId } = req.params;

        if (req.user.role === 'tenant' && String(req.user.tenantId) !== tenantId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const tenant = await Tenant.findById(tenantId).populate('house');
        if (!tenant)       return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house' });

        const rent   = tenant.house.rent;
        const months = await Payment.distinct('month', {
            tenant: tenantId,
            status: { $in: ['paid', 'partial'] }
        });

        const results = await Promise.all(
            months.map(async month => {
                const s = await getMonthSummary(tenantId, month, rent);
                return { month, ...s };
            })
        );

        results.sort((a, b) => new Date('1 ' + b.month) - new Date('1 ' + a.month));
        res.json(results);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /arrears — FIX 1: admin only
app.get('/arrears', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenants      = await Tenant.find().populate('house');
        const arrearsList  = [];
        const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

        for (const tenant of tenants) {
            if (!tenant.house) continue;

            const rent    = tenant.house.rent;
            const summary = await getMonthSummary(tenant._id, currentMonth, rent);

            if (summary.balance > 0) {
                arrearsList.push({
                    tenantId:  tenant._id,
                    tenant:    tenant.name,
                    email:     tenant.email,
                    house:     tenant.house.name,
                    month:     currentMonth,
                    rent,
                    totalPaid: summary.totalPaid,
                    balance:   summary.balance,
                    status:    summary.status
                });
            }
        }

        res.json(arrearsList);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /arrears/:month — FIX 1: admin only
app.get('/arrears/:month', authMiddleware, adminOnly, async (req, res) => {
    try {
        const month   = req.params.month;
        const tenants = await Tenant.find().populate('house');
        const result  = [];

        for (const tenant of tenants) {
            if (!tenant.house) continue;

            const rent    = tenant.house.rent;
            const summary = await getMonthSummary(tenant._id, month, rent);

            if (summary.balance > 0) {
                result.push({
                    tenantId:  tenant._id,
                    tenant:    tenant.name,
                    email:     tenant.email,
                    house:     tenant.house.name,
                    month,
                    rent,
                    totalPaid: summary.totalPaid,
                    balance:   summary.balance,
                    status:    summary.status
                });
            }
        }

        res.json(result);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// M-PESA STK PUSH (RENT)
// ═══════════════════════════════════════

// POST /stkpush — FIX 8: tenant-only (phone always from their own record)
app.post('/stkpush', authMiddleware, async (req, res) => {
    try {
        // Only tenants initiate rent payments on their own behalf
        if (req.user.role !== 'tenant') {
            return res.status(403).json({ message: 'Tenants only. Use POST /payments to record cash/manual payments.' });
        }

        const { amount, month } = req.body;

        if (!amount || !month) {
            return res.status(400).json({ message: 'amount and month are required' });
        }
        if (amount <= 0) {
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        const tenantId = req.user.tenantId;
        if (!tenantId) return res.status(400).json({ message: 'No tenant linked to this account' });

        const tenant = await Tenant.findById(tenantId).populate('house');
        if (!tenant)       return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.phone) return res.status(400).json({ message: 'No phone number on your account' });
        if (!tenant.house) return res.status(400).json({ message: 'No house assigned — contact your landlord' });

        const rent = tenant.house.rent;

        const summary = await getMonthSummary(tenantId, month, rent);
        if (summary.status === 'paid') {
            return res.status(400).json({
                message: `Rent for ${month} is already fully paid ✅`,
                summary
            });
        }
        if (amount > summary.balance) {
            return res.status(400).json({
                message: `Amount exceeds balance. Remaining balance is Ksh ${summary.balance}.`,
                balance: summary.balance,
                summary
            });
        }

        const token     = await getRentToken();
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
                PartyA:            tenant.phone,
                PartyB:            process.env.MPESA_SHORTCODE,
                PhoneNumber:       tenant.phone,
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

        const newTotalPaid = summary.totalPaid + amount;
        const newBalance   = Math.max(0, rent - newTotalPaid);

        await Payment.create({
            tenant:            tenant._id,
            house:             tenant.house._id,
            amount,
            month,
            rentAmount:        rent,
            totalPaid:         newTotalPaid,
            balance:           newBalance,
            status:            'pending',
            method:            'mpesa',
            checkoutRequestId: data.CheckoutRequestID,
            merchantRequestId: data.MerchantRequestID
        });

        res.json({
            message:           'M-Pesa prompt sent to your phone 📱',
            checkoutRequestId: data.CheckoutRequestID,
            merchantRequestId: data.MerchantRequestID,
            summary: {
                currentlyPaid: summary.totalPaid,
                balance:       summary.balance,
                thisPayment:   amount
            }
        });

    } catch (err) {
        console.error('🔥 STK Push error:', err.response?.data || err.message);
        res.status(500).json({
            error:   'STK Push failed',
            details: err.response?.data || err.message
        });
    }
});

// POST /callback — Safaricom rent payment callback
app.post('/callback', async (req, res) => {
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    try {
        const stk = req.body?.Body?.stkCallback;
        if (!stk) return;

        const checkoutRequestId = stk.CheckoutRequestID;
        const resultCode        = stk.ResultCode;

        const payment = await Payment.findOne({ checkoutRequestId })
            .populate('tenant')
            .populate('house');

        if (!payment) {
            console.log('Callback: no pending payment found for', checkoutRequestId);
            return;
        }

        if (resultCode === 0) {
            const items     = stk.CallbackMetadata?.Item || [];
            const getItem   = name => items.find(i => i.Name === name)?.Value;
            const mpesaCode = getItem('MpesaReceiptNumber') || '';

            const rent         = payment.house?.rent || payment.rentAmount;
            const previousAgg  = await Payment.aggregate([
                {
                    $match: {
                        tenant: payment.tenant._id,
                        month:  payment.month,
                        status: { $in: ['paid', 'partial'] },
                        _id:    { $ne: payment._id }
                    }
                },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]);

            const prevPaid     = previousAgg[0]?.total || 0;
            const newTotalPaid = prevPaid + payment.amount;
            const newBalance   = Math.max(0, rent - newTotalPaid);
            const newStatus    = newBalance === 0 ? 'paid' : 'partial';

            payment.status    = newStatus;
            payment.mpesaCode = mpesaCode;
            payment.totalPaid = newTotalPaid;
            payment.balance   = newBalance;
            payment.datePaid  = new Date();
            await payment.save();

            console.log(`✅ M-Pesa confirmed: ${mpesaCode} | ${payment.month} | ${newStatus}`);

            if (payment.tenant?.email) {
                const { Resend } = require('resend');
                const resend     = new Resend(process.env.RESEND_API_KEY);
                const statusColor = newStatus === 'paid' ? '#16a34a' : '#d97706';
                const statusLabel = newStatus === 'paid' ? 'Fully Paid ✓' : 'Partial Payment';
                const statusBg    = newStatus === 'paid' ? '#dcfce7' : '#fef3c7';

                resend.emails.send({
                    from:    'Affordable Rentals 🏠 <support@affordablerentals.site>',
                    to:      payment.tenant.email,
                    subject: `${newStatus === 'paid' ? '✅' : '🔔'} M-Pesa Payment Confirmed — ${payment.month}`,
                    html: `
                    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                      <div style="background:linear-gradient(135deg,#16a34a,#15803d);padding:32px;text-align:center">
                        <div style="font-size:40px;margin-bottom:8px">✅</div>
                        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Payment Confirmed</h1>
                        <p style="color:#bbf7d0;margin:6px 0 0;font-size:13px">${payment.month}</p>
                      </div>
                      <div style="padding:32px">
                        <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${payment.tenant.name.split(' ')[0]}</strong>,</p>
                        <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">Your M-Pesa payment has been received and confirmed.</p>
                        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;margin-bottom:24px">
                          <table style="width:100%;border-collapse:collapse">
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">House</td>        <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${payment.house?.name || '—'}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Month</td>        <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${payment.month}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">This Payment</td> <td style="color:#16a34a;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(payment.amount).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Total Paid</td>   <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">Ksh ${Number(newTotalPaid).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Balance</td>      <td style="color:${newBalance > 0 ? '#d97706' : '#16a34a'};font-size:13px;font-weight:700;text-align:right">Ksh ${Number(newBalance).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">M-Pesa Code</td>  <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right;font-family:monospace">${mpesaCode}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Status</td>       <td style="text-align:right"><span style="background:${statusBg};color:${statusColor};font-size:11px;font-weight:600;padding:2px 10px;border-radius:99px">${statusLabel}</span></td></tr>
                          </table>
                        </div>
                        ${newBalance > 0 ? `<div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:20px"><p style="color:#92400e;font-size:13px;margin:0">⚠️ Balance remaining: <strong>Ksh ${Number(newBalance).toLocaleString()}</strong>. Please pay before your due date.</p></div>` : ''}
                        <p style="color:#94a3b8;font-size:12px;margin:0">Keep this as your receipt. Contact <a href="mailto:support@affordablerentals.site" style="color:#16a34a">support@affordablerentals.site</a> for queries.</p>
                      </div>
                      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center">
                        <p style="color:#cbd5e1;font-size:11px;margin:0">© ${new Date().getFullYear()} Affordable Rentals</p>
                      </div>
                    </div>`
                }).catch(err => console.error('Confirmation email failed:', err.message));
            }

        } else {
            payment.status = 'failed';
            await payment.save();
            console.log(`❌ Payment failed — ResultCode: ${resultCode}`);
        }

    } catch (err) {
        console.error('Callback processing error:', err.message);
    }
});

// GET /payment-status/:checkoutRequestId — FIX 9: return 'confirmed' when paid/partial
// tenant.js polls for status === 'confirmed'
app.get('/payment-status/:checkoutRequestId', authMiddleware, async (req, res) => {
    try {
        const payment = await Payment.findOne({
            checkoutRequestId: req.params.checkoutRequestId
        });

        if (!payment) return res.status(404).json({ status: 'not_found' });

        // FIX 9: Map internal status to what the frontend expects
        // 'paid' or 'partial' → 'confirmed' (payment went through)
        // 'pending' → 'pending' (still waiting)
        // 'failed' → 'failed'
        let clientStatus = payment.status;
        if (payment.status === 'paid' || payment.status === 'partial') {
            clientStatus = 'confirmed';
        }

        res.json({
            status:    clientStatus,
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

        const token     = await getRentToken();
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
// RECEIPTS
// ═══════════════════════════════════════

// GET /receipt/:paymentId — FIX 1: auth required; tenant sees own only
app.get('/receipt/:paymentId', authMiddleware, async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        // Tenant can only access their own receipt
        if (req.user.role === 'tenant' && String(payment.tenant?._id) !== String(req.user.tenantId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        res.json(payment);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /receipt/pdf/:paymentId — FIX 1: auth required; tenant sees own only
app.get('/receipt/pdf/:paymentId', authMiddleware, async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        if (req.user.role === 'tenant' && String(payment.tenant?._id) !== String(req.user.tenantId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const doc = new PDFDocument();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=receipt-${payment._id}.pdf`);

        doc.pipe(res);
        doc.fontSize(20).text('RENT RECEIPT', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Tenant:      ${payment.tenant.name}`);
        doc.text(`House:       ${payment.house.name}`);
        doc.text(`Amount Paid: Ksh ${Number(payment.amount).toLocaleString()}`);
        doc.text(`Total Paid:  Ksh ${Number(payment.totalPaid || payment.amount).toLocaleString()}`);
        doc.text(`Balance:     Ksh ${Number(payment.balance || 0).toLocaleString()}`);
        doc.text(`Month:       ${payment.month}`);
        doc.text(`Status:      ${(payment.status || 'paid').toUpperCase()}`);
        doc.text(`Date:        ${new Date(payment.datePaid).toDateString()}`);
        doc.text(`Receipt ID:  ${payment._id}`);
        doc.moveDown();
        doc.text('Thank you for your payment — Affordable Rentals');
        doc.end();

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════

// GET /dashboard/:month — FIX 3 & 4: subscription guard + fixed arrears calc
app.get('/dashboard/:month', authMiddleware, adminOnly, checkSubscription, async (req, res) => {
    try {
        const month   = req.params.month;
        const tenants = await Tenant.find().populate('house');
        const houses  = await House.find();

        let totalIncome  = 0;
        let totalArrears = 0;
        let occupied     = 0;

        houses.forEach(h => { if (h.status === 'occupied') occupied++; });

        // FIX 4: use getMonthSummary for each tenant so partial payments are counted correctly
        for (const tenant of tenants) {
            if (!tenant.house) continue;

            const rent    = tenant.house.rent;
            const summary = await getMonthSummary(tenant._id, month, rent);

            totalIncome  += summary.totalPaid;
            totalArrears += summary.balance;
        }

        res.json({
            month,
            totalIncome,
            totalArrears,
            totalTenants:   tenants.length,
            totalHouses:    houses.length,
            occupiedHouses: occupied,
            vacantHouses:   houses.length - occupied,
            warning:        req.subscriptionWarning || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// SUBSCRIPTION SYSTEM
// ═══════════════════════════════════════

// GET /subscription-status — admin only (no subscription guard — this IS the status endpoint)
app.get('/subscription-status', authMiddleware, adminOnly, async (req, res) => {
    try {
        const admin = await User.findById(req.user.id)
            .select('-password -mpesaConsumerKey -mpesaConsumerSecret -paybillPasskey')
            .populate('subscriptionPlan');

        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        const now          = new Date();
        let   expiryDate   = null;
        let   daysRemaining = 0;

        if (admin.subscriptionStatus === 'trial')  expiryDate = admin.trialEndsAt;
        if (admin.subscriptionStatus === 'active') expiryDate = admin.subscriptionExpiry;
        if (admin.subscriptionStatus === 'grace')  expiryDate = admin.gracePeriodUntil;

        if (expiryDate) {
            daysRemaining = Math.max(0, Math.ceil((new Date(expiryDate) - now) / (1000 * 60 * 60 * 24)));
        }

        const lastPayment = await SubscriptionPayment.findOne({
            landlord: admin._id,
            status:   'paid'
        }).sort({ paidAt: -1 }).populate('plan', 'name price');

        res.json({
            subscriptionStatus:      admin.subscriptionStatus,
            subscriptionPlan:        admin.subscriptionPlan,
            subscriptionExpiry:      admin.subscriptionExpiry,
            trialEndsAt:             admin.trialEndsAt,
            gracePeriodUntil:        admin.gracePeriodUntil,
            lastSubscriptionPayment: admin.lastSubscriptionPayment,
            suspendedReason:         admin.suspendedReason,
            landlordPhone:           admin.landlordPhone,
            daysRemaining,
            lastPayment:             lastPayment || null,
            warning:                 req.subscriptionWarning || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /subscription-plans — public (landlord needs to see plans before paying)
app.get('/subscription-plans', async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1, price: 1 });
        res.json(plans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /subscribe — admin initiates subscription payment via M-Pesa
app.post('/subscribe', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { planId, phone } = req.body;

        if (!planId || !phone) {
            return res.status(400).json({ message: 'planId and phone are required' });
        }

        const plan = await SubscriptionPlan.findById(planId);
        if (!plan || !plan.isActive) {
            return res.status(404).json({ message: 'Plan not found or inactive' });
        }

        const admin = await User.findById(req.user.id);
        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        if (!admin.landlordPhone) {
            admin.landlordPhone = phone;
            await admin.save();
        }

        const token     = await getSystemToken();
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password  = Buffer.from(
            process.env.SYSTEM_PAYBILL + process.env.SYSTEM_PASSKEY + timestamp
        ).toString('base64');

        const stkRes = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: process.env.SYSTEM_PAYBILL,
                Password:          password,
                Timestamp:         timestamp,
                TransactionType:   'CustomerPayBillOnline',
                Amount:            plan.price,
                PartyA:            phone,
                PartyB:            process.env.SYSTEM_PAYBILL,
                PhoneNumber:       phone,
                CallBackURL:       `${process.env.BASE_URL}/subscription-callback`,
                AccountReference:  `Sub-${plan.name}`,
                TransactionDesc:   `${plan.name} subscription — Affordable Rentals`
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

        await SubscriptionPayment.create({
            landlord:          admin._id,
            plan:              plan._id,
            amount:            plan.price,
            durationDays:      plan.durationDays,
            status:            'pending',
            phone,
            checkoutRequestId: data.CheckoutRequestID,
            merchantRequestId: data.MerchantRequestID
        });

        res.json({
            message:           `M-Pesa prompt sent to ${phone} 📱`,
            checkoutRequestId: data.CheckoutRequestID,
            plan: { name: plan.name, price: plan.price, durationDays: plan.durationDays }
        });

    } catch (err) {
        console.error('🔥 Subscribe STK error:', err.response?.data || err.message);
        res.status(500).json({
            error:   'Subscription payment failed',
            details: err.response?.data || err.message
        });
    }
});

// POST /subscription-callback — Safaricom subscription payment callback
app.post('/subscription-callback', async (req, res) => {
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    try {
        const stk = req.body?.Body?.stkCallback;
        if (!stk) return;

        const checkoutRequestId = stk.CheckoutRequestID;
        const resultCode        = stk.ResultCode;

        const subPayment = await SubscriptionPayment.findOne({ checkoutRequestId })
            .populate('plan')
            .populate('landlord');

        if (!subPayment) {
            console.log('Subscription callback: no pending payment for', checkoutRequestId);
            return;
        }

        if (resultCode === 0) {
            const items     = stk.CallbackMetadata?.Item || [];
            const getItem   = name => items.find(i => i.Name === name)?.Value;
            const mpesaCode = getItem('MpesaReceiptNumber') || '';

            const now    = new Date();
            const admin  = subPayment.landlord;
            const plan   = subPayment.plan;

            let baseDate = now;
            if (
                admin.subscriptionStatus === 'active' &&
                admin.subscriptionExpiry &&
                admin.subscriptionExpiry > now
            ) {
                baseDate = admin.subscriptionExpiry;
            }

            const newExpiry = new Date(baseDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

            subPayment.status    = 'paid';
            subPayment.mpesaCode = mpesaCode;
            subPayment.paidAt    = now;
            subPayment.expiresAt = newExpiry;
            await subPayment.save();

            await User.findByIdAndUpdate(admin._id, {
                subscriptionStatus:      'active',
                subscriptionPlan:        plan._id,
                subscriptionExpiry:      newExpiry,
                gracePeriodUntil:        null,
                suspendedReason:         null,
                lastSubscriptionPayment: now
            });

            console.log(`✅ Subscription confirmed: ${mpesaCode} | ${plan.name} | Expires: ${newExpiry.toDateString()}`);

            try {
                const { Resend } = require('resend');
                const resend     = new Resend(process.env.RESEND_API_KEY);

                await resend.emails.send({
                    from:    'Affordable Rentals 🏠 <support@affordablerentals.site>',
                    to:      admin.email,
                    subject: `✅ Subscription Renewed — ${plan.name} Plan`,
                    html: `
                    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                      <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:32px;text-align:center">
                        <div style="font-size:40px;margin-bottom:8px">🎉</div>
                        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Subscription Renewed!</h1>
                        <p style="color:#bae6fd;margin:6px 0 0;font-size:13px">${plan.name} Plan</p>
                      </div>
                      <div style="padding:32px">
                        <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${admin.name.split(' ')[0]}</strong>,</p>
                        <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px">Your subscription has been renewed. You have full access to your dashboard.</p>
                        <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px 24px;margin-bottom:24px">
                          <table style="width:100%;border-collapse:collapse">
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Plan</td>         <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${plan.name}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Amount Paid</td>  <td style="color:#1d4ed8;font-size:15px;font-weight:700;text-align:right">Ksh ${Number(plan.price).toLocaleString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Duration</td>     <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${plan.durationDays} days</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Valid Until</td>  <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right">${newExpiry.toDateString()}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">M-Pesa Code</td> <td style="color:#1e293b;font-size:13px;font-weight:700;text-align:right;font-family:monospace">${mpesaCode}</td></tr>
                          </table>
                        </div>
                        <p style="color:#94a3b8;font-size:12px;margin:0">Contact <a href="mailto:support@affordablerentals.site" style="color:#1d4ed8">support@affordablerentals.site</a> for any queries.</p>
                      </div>
                      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center">
                        <p style="color:#cbd5e1;font-size:11px;margin:0">© ${new Date().getFullYear()} Affordable Rentals</p>
                      </div>
                    </div>`
                });

            } catch (emailErr) {
                console.error('Subscription email failed:', emailErr.message);
            }

        } else {
            subPayment.status = 'failed';
            await subPayment.save();
            console.log(`❌ Subscription payment failed — ResultCode: ${resultCode}`);
        }

    } catch (err) {
        console.error('Subscription callback error:', err.message);
    }
});

// GET /subscription-status-poll/:checkoutRequestId — admin polls after STK push
app.get('/subscription-status-poll/:checkoutRequestId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const payment = await SubscriptionPayment.findOne({
            checkoutRequestId: req.params.checkoutRequestId
        }).populate('plan', 'name price durationDays');

        if (!payment) return res.status(404).json({ status: 'not_found' });

        res.json({
            status:    payment.status,
            mpesaCode: payment.mpesaCode || null,
            plan:      payment.plan,
            expiresAt: payment.expiresAt || null,
            paidAt:    payment.paidAt || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

// POST /rules — admin only
app.post('/rules', authMiddleware, adminOnly, async (req, res) => {
    try {
        const rule = await Rule.create(req.body);
        res.json(rule);
    } catch (err) {
        res.status(500).json({ message: 'Error adding rule' });
    }
});

// GET /rules — public (tenants and guests can read rules)
app.get('/rules', async (req, res) => {
    try {
        const rules = await Rule.find().sort({ createdAt: 1 });
        res.json(rules);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching rules' });
    }
});

// DELETE /rules/:id — admin only
app.delete('/rules/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const rule = await Rule.findByIdAndDelete(req.params.id);
        if (!rule) return res.status(404).json({ message: 'Rule not found' });
        res.json({ message: 'Rule deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting rule' });
    }
});


// ═══════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════

// POST /announcements — admin only
app.post('/announcements', authMiddleware, adminOnly, async (req, res) => {
    try {
        const a = await Announcement.create(req.body);
        res.json(a);
    } catch (err) {
        res.status(500).json({ message: 'Error creating announcement' });
    }
});

// GET /announcements — public (tenants read announcements)
app.get('/announcements', async (req, res) => {
    try {
        const list = await Announcement.find().sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching announcements' });
    }
});

// DELETE /announcements/:id — admin only
app.delete('/announcements/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const a = await Announcement.findByIdAndDelete(req.params.id);
        if (!a) return res.status(404).json({ message: 'Announcement not found' });
        res.json({ message: 'Announcement deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting announcement' });
    }
});


// ═══════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════

// POST /messages — FIX 11: tenant only (guards against admin or null tenantId)
app.post('/messages', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant') {
            return res.status(403).json({ message: 'Tenants only. Admins use POST /messages/reply.' });
        }
        if (!req.user.tenantId) {
            return res.status(400).json({ message: 'No tenant linked to this account' });
        }

        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ message: 'Message text is required' });

        const msg = await Message.create({
            tenant: req.user.tenantId,
            sender: 'tenant',
            text:   text.trim(),
            isRead: false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: 'Error sending message' });
    }
});

// POST /messages/reply — admin replies to a tenant
app.post('/messages/reply', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { tenantId, text } = req.body;
        if (!tenantId || !text || !text.trim()) {
            return res.status(400).json({ message: 'tenantId and text are required' });
        }

        const msg = await Message.create({
            tenant: tenantId,
            sender: 'admin',
            text:   text.trim(),
            isRead: false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: 'Error sending reply' });
    }
});

// GET /messages/my — tenant's own thread
app.get('/messages/my', authMiddleware, async (req, res) => {
    try {
        if (!req.user.tenantId) {
            return res.status(400).json({ message: 'No tenant linked to this account' });
        }
        const messages = await Message.find({ tenant: req.user.tenantId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching messages' });
    }
});

// GET /messages/thread/:tenantId — admin views a tenant's thread
app.get('/messages/thread/:tenantId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const messages = await Message.find({ tenant: req.params.tenantId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching thread' });
    }
});

// PUT /messages/read/:tenantId — FIX 12: admin OR tenant can call this
// Admin: marks tenant→admin messages as read
// Tenant: marks admin→tenant messages as read (own thread only)
app.put('/messages/read/:tenantId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'tenant') {
            // Tenant can only mark their own thread
            if (String(req.user.tenantId) !== req.params.tenantId) {
                return res.status(403).json({ message: 'Forbidden' });
            }
            // Mark admin messages in their thread as read
            await Message.updateMany(
                { tenant: req.params.tenantId, sender: 'admin', isRead: false },
                { isRead: true }
            );
        } else {
            // Admin: mark tenant messages as read
            await Message.updateMany(
                { tenant: req.params.tenantId, sender: 'tenant', isRead: false },
                { isRead: true }
            );
        }

        res.json({ message: 'Marked as read' });

    } catch (err) {
        res.status(500).json({ message: 'Error marking as read' });
    }
});

// GET /messages/unread — admin: unread counts per tenant
app.get('/messages/unread', authMiddleware, adminOnly, async (req, res) => {
    try {
        const unread = await Message.aggregate([
            { $match: { sender: 'tenant', isRead: false } },
            { $group: { _id: '$tenant', count: { $sum: 1 } } }
        ]);
        res.json(unread);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching unread messages' });
    }
});

// GET /messages/unread-mine — tenant: their unread count from admin
app.get('/messages/unread-mine', authMiddleware, async (req, res) => {
    try {
        if (!req.user.tenantId) return res.json({ count: 0 });

        const count = await Message.countDocuments({
            tenant: req.user.tenantId,
            sender: 'admin',
            isRead: false
        });
        res.json({ count });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching unread count' });
    }
});


// ═══════════════════════════════════════
// STACKLORD ROUTES
// ═══════════════════════════════════════

// GET /stacklord/stats — platform overview
app.get('/stacklord/stats', stacklordAuth, async (req, res) => {
    try {
        const admin = await User.findOne({ role: 'admin' })
            .select('-password -mpesaConsumerKey -mpesaConsumerSecret -paybillPasskey')
            .populate('subscriptionPlan');

        const totalTenants  = await User.countDocuments({ role: 'tenant' });
        const totalHouses   = await House.countDocuments();
        const totalPayments = await SubscriptionPayment.countDocuments({ status: 'paid' });

        const revenueResult = await SubscriptionPayment.aggregate([
            { $match: { status: 'paid' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalRevenue = revenueResult[0]?.total || 0;

        const now           = new Date();
        let   daysRemaining = 0;
        let   expiryDate    = null;

        if (admin) {
            if (admin.subscriptionStatus === 'trial')  expiryDate = admin.trialEndsAt;
            if (admin.subscriptionStatus === 'active') expiryDate = admin.subscriptionExpiry;
            if (admin.subscriptionStatus === 'grace')  expiryDate = admin.gracePeriodUntil;
            if (expiryDate) {
                daysRemaining = Math.max(0, Math.ceil((new Date(expiryDate) - now) / (1000 * 60 * 60 * 24)));
            }
        }

        res.json({
            landlord: admin,
            stats: {
                totalTenants,
                totalHouses,
                totalRevenue,
                totalPayments,
                daysRemaining,
                subscriptionStatus: admin?.subscriptionStatus || 'unknown'
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /stacklord/subscription-payments
app.get('/stacklord/subscription-payments', stacklordAuth, async (req, res) => {
    try {
        const payments = await SubscriptionPayment.find()
            .populate('plan', 'name price durationDays')
            .populate('landlord', 'name email')
            .sort({ createdAt: -1 });
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /stacklord/suspend
app.post('/stacklord/suspend', stacklordAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ message: 'Suspension reason is required' });

        const admin = await User.findOneAndUpdate(
            { role: 'admin' },
            {
                subscriptionStatus: 'suspended',
                suspendedReason:    reason,
                suspendedAt:        new Date(),
                suspendedBy:        'stacklord'
            },
            { new: true }
        );

        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        res.json({ message: 'Landlord suspended ✅', reason, admin: admin.name });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /stacklord/unsuspend
app.post('/stacklord/unsuspend', stacklordAuth, async (req, res) => {
    try {
        const admin = await User.findOne({ role: 'admin' });
        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        const now       = new Date();
        let   newStatus = 'trial';

        if (admin.subscriptionExpiry && admin.subscriptionExpiry > now) {
            newStatus = 'active';
        } else if (admin.trialEndsAt && admin.trialEndsAt > now) {
            newStatus = 'trial';
        } else {
            newStatus = 'expired';
        }

        await User.findOneAndUpdate(
            { role: 'admin' },
            { subscriptionStatus: newStatus, suspendedReason: null, suspendedAt: null, suspendedBy: null }
        );

        res.json({ message: `Landlord unsuspended ✅ — Status restored to: ${newStatus}` });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /stacklord/extend
app.post('/stacklord/extend', stacklordAuth, async (req, res) => {
    try {
        const { days, note } = req.body;
        if (!days || days < 1) return res.status(400).json({ message: 'days must be a positive number' });

        const admin = await User.findOne({ role: 'admin' });
        if (!admin) return res.status(404).json({ message: 'Admin not found' });

        const now       = new Date();
        const base      = (admin.subscriptionExpiry && admin.subscriptionExpiry > now)
                          ? admin.subscriptionExpiry
                          : now;
        const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

        await User.findOneAndUpdate(
            { role: 'admin' },
            {
                subscriptionStatus: 'active',
                subscriptionExpiry: newExpiry,
                gracePeriodUntil:   null,
                suspendedReason:    null
            }
        );

        await SubscriptionPayment.create({
            landlord:         admin._id,
            plan:             admin.subscriptionPlan || null,
            amount:           0,
            durationDays:     days,
            status:           'paid',
            paidAt:           now,
            expiresAt:        newExpiry,
            manuallyExtended: true,
            manualNote:       note || `Manually extended by Stacklord for ${days} days`
        });

        res.json({
            message:   `Subscription extended by ${days} days ✅`,
            newExpiry: newExpiry.toDateString(),
            note:      note || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /stacklord/plans
app.get('/stacklord/plans', stacklordAuth, async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find().sort({ sortOrder: 1 });
        res.json(plans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /stacklord/plans
app.post('/stacklord/plans', stacklordAuth, async (req, res) => {
    try {
        const { name, price, durationDays, description, features, sortOrder } = req.body;

        if (!name || !price || !durationDays) {
            return res.status(400).json({ message: 'name, price and durationDays are required' });
        }

        const plan = await SubscriptionPlan.create({
            name,
            price,
            durationDays,
            description: description || '',
            features:    features    || [],
            sortOrder:   sortOrder   || 0,
            createdBy:   'stacklord'
        });

        res.status(201).json({ message: 'Plan created ✅', plan });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /stacklord/plans/:id
app.put('/stacklord/plans/:id', stacklordAuth, async (req, res) => {
    try {
        const plan = await SubscriptionPlan.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json({ message: 'Plan updated ✅', plan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /stacklord/plans/:id
app.delete('/stacklord/plans/:id', stacklordAuth, async (req, res) => {
    try {
        const plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json({ message: 'Plan deleted ✅' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /stacklord/plans/:id/toggle
app.post('/stacklord/plans/:id/toggle', stacklordAuth, async (req, res) => {
    try {
        const plan = await SubscriptionPlan.findById(req.params.id);
        if (!plan) return res.status(404).json({ message: 'Plan not found' });

        plan.isActive = !plan.isActive;
        await plan.save();

        res.json({ message: `Plan ${plan.isActive ? 'activated' : 'deactivated'} ✅`, isActive: plan.isActive });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// CRON — RENT REMINDERS (daily 9 AM)
// ═══════════════════════════════════════

async function checkArrears() {
    const today      = new Date();
    const currentDay = today.getDate();
    const month      = today.toLocaleString('default', { month: 'long', year: 'numeric' });

    console.log(`🕘 Running rent check for ${month}...`);

    try {
        const tenants = await Tenant.find().populate('house');

        for (const tenant of tenants) {
            if (!tenant.house)               continue;
            if (currentDay < tenant.dueDate) continue;

            // FIX 15: use getMonthSummary so partial payers are not falsely reminded
            const rent    = tenant.house.rent;
            const summary = await getMonthSummary(tenant._id, month, rent);

            if (summary.status !== 'paid') {
                console.log(`⚠️  ${tenant.name} — ${summary.status} for ${month} — balance Ksh ${summary.balance}`);

                sendRentReminder({
                    name:    tenant.name,
                    email:   tenant.email,
                    house:   tenant.house.name,
                    rent:    tenant.house.rent,
                    month,
                    dueDate: tenant.dueDate,
                    arrears: summary.balance
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
// START
// ═══════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT} 🚀`);
});