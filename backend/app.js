const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();

app.use(cors());
app.use(express.json());

//const nodemailer  = require('nodemailer');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const PDFDocument = require('pdfkit');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const axios       = require('axios');
const cron        = require('node-cron');
const { sendWelcomeEmail, sendRentReminder, sendMoveOutEmail } = require('./emails');

// ── Models ──
const Tenant       = require('./models/Tenant');
const House        = require('./models/House');
const Payment      = require('./models/Payment');
const User         = require('./models/User');
const Rule         = require('./models/Rule');
const Announcement = require('./models/Announcement');
const Message      = require('./models/Message');
const Settings = require('./models/Settings');

// ── DB ──
const connectDB = require('./db');
connectDB();

// ═══════════════════════════════════════════════════════
//  ADD TO server.js
// ═══════════════════════════════════════════════════════

// 1. Add this with your other model requires at the top:
//    const Settings = require('./models/Settings');


// ════════════════════════════════
// MAINTENANCE MODE ROUTES
// ════════════════════════════════

// 📥 GET maintenance status — PUBLIC (no auth needed)
// Tenant checks this on load before showing dashboard
app.get('/maintenance', async (req, res) => {
    try {
        const settings = await Settings.findOne();

        if (!settings) {
            // No settings doc yet — maintenance is off
            return res.json({ maintenanceMode: false, message: '' });
        }

        res.json({
            maintenanceMode:    settings.maintenanceMode,
            maintenanceMessage: settings.maintenanceMessage
        });

    } catch (err) {
        // If DB fails, don't lock everyone out — default to off
        res.json({ maintenanceMode: false, message: '' });
    }
});


// 🔧 PUT maintenance status — ADMIN ONLY
// Body: { maintenanceMode: true/false, maintenanceMessage: "..." (optional) }
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
    {
        upsert:              true,
        returnDocument:      'after',   // ✅ replaces new: true
        setDefaultsOnInsert: true
    }
);

        res.json({
            message:         `Maintenance mode ${maintenanceMode ? 'enabled 🔧' : 'disabled ✅'}`,
            maintenanceMode: settings.maintenanceMode
        });

    } catch (err) {
        res.status(500).json({ message: 'Failed to update maintenance mode' });
    }
});

// ── Mailer ──
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,   // FIX #9 — use env vars
        pass: process.env.GMAIL_PASS
    }
});

// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token" });

    try {
        const token   = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET); // FIX #8
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: "Invalid token" });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== "admin") {
        return res.status(403).json({ message: "Admins only" });
    }
    next();
}

// ═══════════════════════════════════════
// M-PESA
// ═══════════════════════════════════════

async function getToken() {
    const auth = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    const res = await axios.get(
        "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        { headers: { Authorization: `Basic ${auth}` } }
    );

    return res.data.access_token;
}

// ═══════════════════════════════════════════════════════
//  ADD THESE ROUTES TO server.js
//  Place them in the AUTH section, after /login
// ═══════════════════════════════════════════════════════


// ── Tenant: Change own password ──
// POST /change-password
// Requires: currentPassword, newPassword in body
// Auth: any logged-in user
app.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: "Both fields required" });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters" });
        }

        // Find user by id from token
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(400).json({ message: "Current password is incorrect" });

        // Hash and save new password
        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ message: "Password updated successfully ✅" });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════
//  REPLACE YOUR EXISTING M-PESA ROUTES IN server.js
//  WITH THESE. Also add this near the top of server.js:
//
//  const mpesa = require('./mpesa');
//  mpesa.init({ Tenant, House, Payment });
// ═══════════════════════════════════════════════════════


// ── STK PUSH ──
// POST /stkpush
// Body: { phone, amount, month }
// Auth: logged in tenant or admin
app.post('/stkpush', authMiddleware, async (req, res) => {
    try {
        const { phone, amount, month } = req.body;

        if (!phone || !amount || !month) {
            return res.status(400).json({ message: 'phone, amount and month are required' });
        }

        // Use tenant's registered phone if they don't provide one
        let payPhone = phone;
        if (req.user.role === 'tenant') {
            const tenant = await Tenant.findById(req.user.tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            payPhone = tenant.phone; // always use registered phone for security
        }

        const result = await mpesa.stkPush({
            phone:      payPhone,
            amount,
            accountRef: `Rent-${month}`,
            tenantId:   req.user.tenantId || req.body.tenantId
        });

        if (result.ResponseCode !== '0') {
            return res.status(400).json({
                message: result.ResponseDescription || 'STK push failed',
                result
            });
        }

        // Store pending so callback can match it
        mpesa.storePending(result.CheckoutRequestID, {
            tenantId: req.user.tenantId || req.body.tenantId,
            month,
            amount,
            phone:    payPhone
        });

        res.json({
            message:            'M-Pesa prompt sent to your phone 📱',
            checkoutRequestId:  result.CheckoutRequestID,
            merchantRequestId:  result.MerchantRequestID
        });

    } catch (err) {
        console.error('🔥 STK Push error:', err.response?.data || err.message);
        res.status(500).json({
            error:   'STK Push failed',
            details: err.response?.data || err.message
        });
    }
});


// ── MPESA CALLBACK ──
// POST /callback
// Called by Safaricom servers after payment attempt
// No auth — Safaricom doesn't send a token
app.post('/callback', async (req, res) => {
    // Always respond 200 immediately — Safaricom expects instant response
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    // Process asynchronously after responding
    try {
        const outcome = await mpesa.processCallback(req.body);
        console.log('Callback processed:', outcome);
    } catch (err) {
        console.error('Callback processing error:', err.message);
    }
});


// ── PAYMENT STATUS POLLING ──
// GET /payment-status/:checkoutRequestId
// Frontend polls this every 3s after STK push
// Auth: logged in
app.get('/payment-status/:checkoutRequestId', authMiddleware, (req, res) => {
    const entry = mpesa.getPending(req.params.checkoutRequestId);

    if (!entry) {
        return res.status(404).json({ status: 'not_found' });
    }

    // Don't expose internal data — just send what frontend needs
    res.json({
        status:    entry.status,      // 'pending' | 'confirmed' | 'failed' | 'timeout' | 'duplicate'
        paymentId: entry.paymentId || null,
        mpesaCode: entry.mpesaCode || null,
        reason:    entry.resultDesc  || null
    });
});


// ── QUERY STK STATUS (from Safaricom directly) ──
// POST /stk-query
// Use this as a fallback if callback never arrives
// Body: { checkoutRequestId }
app.post('/stk-query', authMiddleware, async (req, res) => {
    try {
        const { checkoutRequestId } = req.body;
        if (!checkoutRequestId) return res.status(400).json({ message: 'checkoutRequestId required' });

        const token     = await mpesa.getToken();
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password  = Buffer.from(
            process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
        ).toString('base64');

        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query',
            {
                BusinessShortCode: process.env.MPESA_SHORTCODE,
                Password:          password,
                Timestamp:         timestamp,
                CheckoutRequestID: checkoutRequestId
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = response.data;

        // ResultCode 0 = success, 1032 = cancelled, 1037 = timeout
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
// ── Admin: Reset any tenant's password ──
// POST /reset-password
// Requires: tenantId, newPassword in body
// Auth: admin only
app.post('/reset-password', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { tenantId, newPassword } = req.body;

        if (!tenantId || !newPassword) {
            return res.status(400).json({ message: "tenantId and newPassword required" });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters" });
        }

        // Find the User linked to this tenantId
        const user = await User.findOne({ tenantId });
        if (!user) return res.status(404).json({ message: "No user account found for this tenant" });

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ message: "Password reset successfully ✅" });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post('/reset-password', authMiddleware, adminOnly, async (req, res) => {
    const { tenantId, newPassword } = req.body;
    const hashed = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate({ tenantId }, { password: hashed });
    res.json({ message: "Password reset ✅" });
});




// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════

app.post('/register', async (req, res) => {
    try {
        const { name, email, password, phone, dueDate } = req.body;
 
        if (!name || !email || !password || !phone) {
            return res.status(400).json({ message: "All fields are required" });
        }
 
        // Check duplicate
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: "An account with this email already exists" });
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
 
        // ✅ Send welcome email (non-blocking — don't fail registration if email fails)
        sendWelcomeEmail({ name, email }).catch(err =>
            console.error('Welcome email failed:', err.message)
        );
 
        res.json({ message: "Account created successfully", user, tenant });
 
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Registration failed — " + err.message });
    }
});


app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Wrong password" });

        const token = jwt.sign(
            { id: user._id, role: user.role, tenantId: user.tenantId },
            process.env.JWT_SECRET,   // FIX #8
            { expiresIn: "1d" }
        );

        res.json({ token });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════

// FIX #1 — authMiddleware added
app.get('/tenant/:id', authMiddleware, async (req, res) => {
    try {
        // Tenant can only see their own data
        if (req.user.role === "tenant" && req.user.tenantId != req.params.id) {
            return res.status(403).json({ message: "Forbidden" });
        }

        const tenant = await Tenant.findById(req.params.id).populate('house');
        if (!tenant) return res.status(404).json({ message: "Tenant not found" });

        const payments  = await Payment.find({ tenant: tenant._id });
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        const rent      = tenant.house ? tenant.house.rent : 0;

        // FIX #5 — count months occupied to calculate real arrears
        const monthsOccupied = payments.length > 0
            ? new Set(payments.map(p => p.month)).size
            : 1;

        const expectedTotal = rent * monthsOccupied;
        const arrears       = Math.max(0, expectedTotal - totalPaid); // never negative

        res.json({ tenant, payments, totalPaid, arrears });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tenants', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = new Tenant(req.body);
        await tenant.save();
        res.status(201).json(tenant);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/tenants', async (req, res) => {
    try {
        const tenants = await Tenant.find();
        res.json(tenants);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/tenants/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const updated = await Tenant.findByIdAndUpdate(
            req.params.id, req.body, { new: true }
        );
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/tenant/:id", authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: "Tenant not found" });

        // Free the house
        if (tenant.house) {
            await House.findByIdAndUpdate(tenant.house, { status: "available" });
        }

        // ✅ DELETE THE USER ACCOUNT TOO
        await User.findOneAndDelete({ tenantId: req.params.id });

        await Tenant.findByIdAndDelete(req.params.id);

        res.json({ message: "Tenant deleted ✅" });

    } catch (err) {
        res.status(500).json({ message: "Error deleting tenant ❌" });
    }
});
// ═══════════════════════════════════════
// HOUSES
// ═══════════════════════════════════════

app.post('/houses', authMiddleware, adminOnly, async (req, res) => {
    try {
        const house = new House(req.body);
        await house.save();
        res.status(201).json(house);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/houses', async (req, res) => {
    try {
        const houses = await House.find();
        res.json(houses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/houses/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
        const updated = await House.findByIdAndUpdate(
            req.params.id, req.body, { new: true }
        );
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/house/:id", authMiddleware, adminOnly, async (req, res) => {
    try {
        const house = await House.findById(req.params.id);
        if (!house) return res.status(404).json({ message: "House not found" });

        if (house.status === "occupied") {
            return res.status(400).json({ message: "Cannot delete occupied house 🚫" });
        }

        await House.findByIdAndDelete(req.params.id);
        res.json({ message: "House deleted 🏡" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error deleting house ❌" });
    }
});

app.put('/assign-house/:tenantId/:houseId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        const house  = await House.findById(req.params.houseId);

        if (!tenant || !house) {
            return res.status(404).json({ message: "Tenant or House not found" });
        }

        if (house.status === "occupied") {
            return res.status(400).json({ message: "This house is already occupied ❌" });
        }

        if (tenant.house) {
            return res.status(400).json({ message: "Tenant already has a house assigned ❌" });
        }

        tenant.house  = house._id;
        house.status  = "occupied";

        await tenant.save();
        await house.save();

        res.json({ message: "House assigned successfully ✅", tenant, house });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/move-out/:tenantId', authMiddleware, adminOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.tenantId);
        if (!tenant) return res.status(404).json({ message: "Tenant not found" });
 
        if (!tenant.house) {
            return res.status(400).json({ message: "This tenant is not assigned to any house" });
        }
 
        const house = await House.findById(tenant.house);
        if (!house) return res.status(404).json({ message: "House not found" });
 
        // ✅ Send goodbye email BEFORE clearing the house link
        // (so we still have house.name available)
        sendMoveOutEmail({
            name:        tenant.name,
            email:       tenant.email,
            house:       house.name,
            moveOutDate: new Date()
        }).catch(err =>
            console.error('Move-out email failed:', err.message)
        );
 
        // Clear house link
        house.status = 'available';
        tenant.house = null;
 
        await house.save();
        await tenant.save();
 
        res.json({
            message: "Tenant moved out successfully 🏠➡️🚪",
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

// FIX #4 — split into two routes: admin records payment, tenant pays via M-Pesa
app.post('/payments', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { tenantId, amount, month } = req.body;

        const tenant = await Tenant.findById(tenantId).populate('house');
        if (!tenant)       return res.status(404).json({ message: "Tenant not found" });
        if (!tenant.house) return res.status(400).json({ message: "Tenant has no house" });

        const existingPayment = await Payment.findOne({ tenant: tenantId, month });
        if (existingPayment) {
            return res.status(400).json({ message: "Payment for this month already exists ❌" });
        }

        const payment = new Payment({
            tenant: tenant._id,
            house:  tenant.house._id,
            amount,
            month
        });

        await payment.save();

        // Generate PDF and email
        const doc     = new PDFDocument();
        let   buffers = [];

        doc.on('data', buffers.push.bind(buffers));

        doc.fontSize(20).text("RENT RECEIPT", { align: "center" });
        doc.moveDown();
        doc.fontSize(12).text(`Tenant: ${tenant.name}`);
        doc.text(`House: ${tenant.house.name}`);
        doc.text(`Amount: Ksh ${amount}`);
        doc.text(`Month: ${month}`);
        doc.text(`Date: ${new Date().toDateString()}`);
        doc.end();

        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);

            await transporter.sendMail({
                from:        `Rental System <${process.env.GMAIL_USER}>`,
                to:          tenant.email,
                subject:     `Rent Receipt - ${month}`,
                text:        "Attached is your rent receipt.",
                attachments: [{ filename: `receipt-${payment._id}.pdf`, content: pdfData }]
            });

            res.json({
                message:   "Payment saved + PDF emailed 📧📄",
                paymentId: payment._id,
                payment
            });
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/payments', async (req, res) => {
    try {
        const payments = await Payment.find().populate('tenant').populate('house');
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.get('/receipt/:paymentId', async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: "Payment not found" });

        res.json(payment);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/receipt/pdf/:paymentId', async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: "Payment not found" });

        const doc = new PDFDocument();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=receipt-${payment._id}.pdf`);

        doc.pipe(res);

        doc.fontSize(20).text("RENT RECEIPT", { align: "center" });
        doc.moveDown();
        doc.fontSize(12).text(`Tenant: ${payment.tenant.name}`);
        doc.text(`House: ${payment.house.name}`);
        doc.text(`Amount Paid: Ksh ${payment.amount}`);
        doc.text(`Month: ${payment.month}`);
        doc.text(`Date: ${payment.datePaid.toDateString()}`);
        doc.moveDown();
        doc.text("Thank you for your payment.");

        doc.end();

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════
// ARREARS
// ═══════════════════════════════════════

app.get('/arrears', async (req, res) => {
    try {
        const tenants     = await Tenant.find().populate('house');
        let   arrearsList = [];

        for (let tenant of tenants) {
            if (!tenant.house) continue;

            const rent     = tenant.house.rent;
            const payments = await Payment.find({ tenant: tenant._id });
            const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
            const arrears   = Math.max(0, rent - totalPaid); // FIX #5 — never negative

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

app.get('/arrears/:month', async (req, res) => {
    try {
        const month   = req.params.month;
        const tenants = await Tenant.find().populate('house');
        let   result  = [];

        for (let tenant of tenants) {
            if (!tenant.house) continue;

            const rent    = tenant.house.rent;
            const payment = await Payment.findOne({ tenant: tenant._id, month });
            const paid    = payment ? payment.amount : 0;
            const arrears = Math.max(0, rent - paid); // FIX #5

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
        houses.forEach(h => { if (h.status === "occupied") occupied++; });

        for (let tenant of tenants) {
            if (!tenant.house) continue;

            const rent    = tenant.house.rent;
            const payment = payments.find(
                p => p.tenant.toString() === tenant._id.toString()
            );
            const paid    = payment ? payment.amount : 0;
            const arrears = Math.max(0, rent - paid); // FIX #5

            if (arrears > 0) totalArrears += arrears;
        }

        res.json({
            month,
            totalIncome,
            totalArrears,
            totalTenants:  tenants.length,
            totalHouses:   houses.length,
            occupiedHouses: occupied,
            vacantHouses:  houses.length - occupied
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════
// CRON — RENT REMINDERS
// ═══════════════════════════════════════

async function sendReminder(tenant) {
    console.log(`📢 Reminder: ${tenant.name}, please pay rent.`);
    await transporter.sendMail({
        from:    `Rent System <${process.env.GMAIL_USER}>`,
        to:      tenant.email,
        subject: "Rent Reminder",
        text:    `Hi ${tenant.name}, your rent is due. Please pay.`
    });
}

async function checkArrears() {
    const today      = new Date();
    const currentDay = today.getDate();
    const month      = today.toLocaleString('default', { month: 'long', year: 'numeric' });
 
    console.log(`🕘 Running rent check for ${month}...`);
 
    try {
        const tenants = await Tenant.find().populate('house');
 
        for (let tenant of tenants) {
            // Skip tenants with no house
            if (!tenant.house) continue;
 
            // Skip if not yet past due date
            if (currentDay < tenant.dueDate) continue;
 
            // Check if already paid this month
            const paid = await Payment.findOne({ tenant: tenant._id, month });
 
            if (!paid) {
                const totalPaid = 0; // no payment this month
                const arrears   = Math.max(0, tenant.house.rent - totalPaid);
 
                console.log(`⚠️  ${tenant.name} has not paid for ${month} — Ksh ${arrears} owed`);
 
                // ✅ Send reminder email (non-blocking)
                sendRentReminder({
                    name:     tenant.name,
                    email:    tenant.email,
                    house:    tenant.house.name,
                    rent:     tenant.house.rent,
                    month,
                    dueDate:  tenant.dueDate,
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
 
// Runs every day at 9AM

cron.schedule('0 9 * * *', () => {
    checkArrears();
});
 
// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  ADD / REPLACE THESE ROUTES IN server.js
// ═══════════════════════════════════════════════════════


// ════════════════════════════════
// RULES
// ════════════════════════════════

// ➕ Add rule (already exists — keep as is)
app.post("/rules", authMiddleware, adminOnly, async (req, res) => {
    try {
        const rule = await Rule.create(req.body);
        res.json(rule);
    } catch (err) {
        res.status(500).json({ message: "Error adding rule" });
    }
});

// 📥 Get all rules (already exists — keep as is)
app.get("/rules", async (req, res) => {
    try {
        const rules = await Rule.find().sort({ createdAt: -1 });
        res.json(rules);
    } catch (err) {
        res.status(500).json({ message: "Error fetching rules" });
    }
});

// 🗑️ DELETE rule — NEW
app.delete("/rules/:id", authMiddleware, adminOnly, async (req, res) => {
    try {
        const rule = await Rule.findByIdAndDelete(req.params.id);
        if (!rule) return res.status(404).json({ message: "Rule not found" });
        res.json({ message: "Rule deleted ✅" });
    } catch (err) {
        res.status(500).json({ message: "Error deleting rule" });
    }
});


// ════════════════════════════════
// ANNOUNCEMENTS
// ════════════════════════════════

// ➕ Create announcement (already exists — keep as is)
app.post("/announcements", authMiddleware, adminOnly, async (req, res) => {
    try {
        const a = await Announcement.create(req.body);
        res.json(a);
    } catch (err) {
        res.status(500).json({ message: "Error creating announcement" });
    }
});

// 📥 Get announcements (already exists — keep as is)
app.get("/announcements", async (req, res) => {
    try {
        const list = await Announcement.find().sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: "Error fetching announcements" });
    }
});

// 🗑️ DELETE announcement — NEW
app.delete("/announcements/:id", authMiddleware, adminOnly, async (req, res) => {
    try {
        const a = await Announcement.findByIdAndDelete(req.params.id);
        if (!a) return res.status(404).json({ message: "Announcement not found" });
        res.json({ message: "Announcement deleted ✅" });
    } catch (err) {
        res.status(500).json({ message: "Error deleting announcement" });
    }
});


// ════════════════════════════════
// MESSAGES — REPLACE ALL 4 message routes
// ════════════════════════════════

// ✉️ Tenant sends message to admin
// POST /messages
// Body: { text }
app.post("/messages", authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ message: "Message text is required" });
        }

        // Only tenants can use this route to send
        // Admin uses /messages/reply
        const msg = await Message.create({
            tenant: req.user.tenantId,  // FIX: was saving to wrong field
            sender: "tenant",
            text:   text.trim(),
            isRead: false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: "Error sending message" });
    }
});


// ✉️ Admin replies to a specific tenant
// POST /messages/reply
// Body: { tenantId, text }
app.post("/messages/reply", authMiddleware, adminOnly, async (req, res) => {
    try {
        const { tenantId, text } = req.body;

        if (!tenantId || !text || !text.trim()) {
            return res.status(400).json({ message: "tenantId and text are required" });
        }

        const msg = await Message.create({
            tenant: tenantId,   // which tenant's thread this belongs to
            sender: "admin",
            text:   text.trim(),
            isRead: false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: "Error sending reply" });
    }
});


// 📥 Tenant gets their own conversation thread
// GET /messages/my
app.get("/messages/my", authMiddleware, async (req, res) => {
    try {
        const messages = await Message.find({
            tenant: req.user.tenantId   // FIX: was querying wrong field
        }).sort({ createdAt: 1 });      // oldest first for chat order

        res.json(messages);

    } catch (err) {
        res.status(500).json({ message: "Error fetching messages" });
    }
});


// 📥 Admin gets all messages for a specific tenant
// GET /messages/thread/:tenantId
app.get("/messages/thread/:tenantId", authMiddleware, adminOnly, async (req, res) => {
    try {
        const messages = await Message.find({
            tenant: req.params.tenantId
        }).sort({ createdAt: 1 });  // oldest first

        res.json(messages);

    } catch (err) {
        res.status(500).json({ message: "Error fetching thread" });
    }
});


// ✅ Mark all messages in a thread as read
// PUT /messages/read/:tenantId
app.put("/messages/read/:tenantId", authMiddleware, adminOnly, async (req, res) => {
    try {
        await Message.updateMany(
            { tenant: req.params.tenantId, sender: "tenant", isRead: false },
            { isRead: true }
        );
        res.json({ message: "Marked as read" });
    } catch (err) {
        res.status(500).json({ message: "Error marking as read" });
    }
});


// 📬 Get unread count per tenant (for admin badge)
// GET /messages/unread
app.get("/messages/unread", authMiddleware, adminOnly, async (req, res) => {
    try {
        const unread = await Message.aggregate([
            { $match: { sender: "tenant", isRead: false } },
            { $group: { _id: "$tenant", count: { $sum: 1 } } }
        ]);
        res.json(unread);
    } catch (err) {
        res.status(500).json({ message: "Error fetching unread messages" });
    }
});


// 📬 Tenant checks for unread admin replies
// GET /messages/unread-mine
app.get("/messages/unread-mine", authMiddleware, async (req, res) => {
    try {
        const count = await Message.countDocuments({
            tenant: req.user.tenantId,
            sender: "admin",
            isRead: false
        });
        res.json({ count });
    } catch (err) {
        res.status(500).json({ message: "Error fetching unread count" });
    }
});
// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT} 🚀`);
});