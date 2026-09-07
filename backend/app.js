const express = require('express');
const app     = express();
app.set('trust proxy', 1);
const cors    = require('cors');
require('dotenv').config();

const ALLOWED_ORIGINS = [
    'https://affordablerentals.site',
    'https://www.affordablerentals.site',
    // dev only — remove before going live:
    //'http://localhost:5500',
    
    //'http://127.0.0.1:5503',
    //'http://127.0.0.1:5502',
];

app.use(cors({
    origin: (origin, callback) => {
        // allow no-origin requests (curl, mobile apps, server-to-server)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        console.log('🚫 CORS blocked origin:', origin); 
        callback(new Error('Not allowed by CORS'));
    }
}));

app.use(express.json());

const PDFDocument = require('pdfkit');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const axios       = require('axios');
const cron        = require('node-cron');
const crypto      = require('crypto');
const mongoose    = require('mongoose');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const Inquiry   = require('./models/Inquiry');
const AuditLog  = require('./models/AuditLog');
const Expense = require('./models/Expense');
const MaintenanceRequest = require('./models/MaintenanceRequest');

// ── Encryption utility ──
const { encrypt, decrypt, safeDecrypt } = require('./encrypt');

// ── Email functions ──
const {
        sendWelcomeEmail,
        sendLandlordWelcomeEmail,
        sendRentReminder,
        sendMoveOutEmail,
        sendPasswordResetEmail,
        sendTenantWelcomeEmail,
        sendPaymentOtpEmail,
        sendRentReceiptEmail,
        sendMpesaConfirmationEmail,
        sendSubscriptionRenewalEmail,
        sendPropertySuspendedEmail,
        sendListingApprovalEmail,
        sendCommissionDueEmail
} = require('./emails');

// ── Models ──
const Tenant              = require('./models/Tenant');
const House               = require('./models/House');
const Payment              = require('./models/Payment');
const User                = require('./models/User');
const Rule                = require('./models/Rule');
const Announcement        = require('./models/Announcement');
const Message             = require('./models/Message');
const Settings            = require('./models/Settings');
const TenantMembership    = require('./models/TenantMembership');
const Property            = require('./models/Property');
const PlatformSettings    = require('./models/PlatformSettings');
const CommissionPayment      = require('./models/CommissionPayment');
const CommissionRateHistory  = require('./models/CommissionRateHistory');
const HouseGroup = require('./models/HouseGroup');

const { geocodeAndSaveProperty } = require('./utils/geocode');

// ── DB ──
const connectDB = require('./db');
connectDB();
// ── In-memory OTP store { email: { code, expiresAt, name } } ──
// BUG 4 NOTE: This is in-memory. For multi-instance deployments, migrate to
// a Redis/DB-backed store. For single-instance this is acceptable.
const otpStore = new Map();

// ── OTP rate-limit store { email: { count, windowStart } } ── (FIX Bug 5)
const otpRateLimit = new Map();

// ── Payment-credential OTP store { landlordId: { code, expiresAt } } ──
// Used by POST /landlord/payment-otp + POST /landlord/setup-payments
const payOtpStore = new Map();

// ── Payment OTP rate-limit store { landlordId: { count, windowStart } } ──
// Limit: 3 OTP requests per 24-hour window per landlord
const payOtpRateLimit = new Map();


function sweepRateLimitMap(map, windowMs) {
    const now = Date.now();
    for (const [key, entry] of map) {
        if (now - entry.windowStart > windowMs) map.delete(key);
    }
}

setInterval(() => {
    sweepRateLimitMap(otpRateLimit, 15 * 60 * 1000);
    sweepRateLimitMap(payOtpRateLimit, 24 * 60 * 60 * 1000);
    sweepRateLimitMap(loginRateLimit, 15 * 60 * 1000);
    sweepRateLimitMap(_inquiryRateLimit, 15 * 60 * 1000);
}, 30 * 60 * 1000); // sweep every 30 min




// ── Rent-reminder dedupe store { "tenantId:month:YYYY-MM-DD": true } ── (FIX Bug 18)
// The cron checks this before sending so a tenant only gets one reminder per
// day even though the underlying arrears check re-runs every day until paid.
// In-memory is fine on a single Render instance; keys are cheap and self-limiting
// since only "today"'s key is ever written/read.
const reminderLog = new Map();

// ── Sanitize a string field: trim and cap length ── (FIX Bug 22)
function sanitize(value, maxLen = 500) {
    if (typeof value !== 'string') return '';   // reject non-strings, don't pass through
    return value.trim().slice(0, maxLen);
}

// ── Pure name-generation logic — no DB access, easy to unit test ──
function generateHouseNames(config) {
    if (!config || !Array.isArray(config.floors) || !config.floors.length) {
        throw new Error('At least one naming group is required');
    }
 
    const names = [];
    for (const floor of config.floors) {
        const prefix   = typeof floor.prefix === 'string' ? floor.prefix : '';
        const start    = Number.isFinite(Number(floor.start))    ? Number(floor.start)    : 1;
        const count    = Number.isFinite(Number(floor.count))    ? Number(floor.count)    : 0;
        const padWidth = Number.isFinite(Number(floor.padWidth)) ? Number(floor.padWidth) : 0;
 
        if (count <= 0) continue;
        if (count > 500) throw new Error('A single group cannot generate more than 500 units');
 
        for (let i = 0; i < count; i++) {
            const num    = start + i;
            const numStr = padWidth > 0 ? String(num).padStart(padWidth, '0') : String(num);
            names.push(`${prefix}${numStr}`);
        }
    }
 
    if (!names.length)        throw new Error('Configuration produced no unit names — check counts');
    if (names.length > 500)   throw new Error('Cannot generate more than 500 units in one request');
 
    return names;
}

function buildFloorNamePairs(floor) {
    const prefix   = typeof floor.prefix === 'string' ? floor.prefix : '';
    const start    = Number.isFinite(Number(floor.start))    ? Number(floor.start)    : 1;
    const count    = Number.isFinite(Number(floor.count))    ? Number(floor.count)    : 0;
    const padWidth = Number.isFinite(Number(floor.padWidth)) ? Number(floor.padWidth) : 0;
 
    if (count <= 0) return [];
    if (count > 500) throw new Error('A single group cannot generate more than 500 units');
 
    const pairs = [];
    for (let i = 0; i < count; i++) {
        const num    = start + i;
        const numStr = padWidth > 0 ? String(num).padStart(padWidth, '0') : String(num);
        pairs.push({ name: `${prefix}${numStr}`, seq: num });
    }
    return pairs;
}
// ── Activity/audit log — fire-and-forget, never blocks the calling route ──
// One shared helper so every mutation logs consistently. `meta` is free-form
// structured context (tenant id, amounts, etc.) for future filtering/export;
// `message` is the plain-English line shown directly in the dashboard feed.
function logActivity({ landlord, property = null, action, message, meta = null, actor = 'landlord' }) {
    AuditLog.create({ landlord, property, action, message, meta, actor })
        .catch(err => console.error('logActivity error:', err.message));
}

// ═══════════════════════════════════════
// COMMISSION SYSTEM — HELPERS
// ═══════════════════════════════════════
//
// FIX (plans → commission migration): the platform used to charge a fixed
// monthly subscription fee per landlord. It's now free forever — instead,
// the stacklord sets a single global commission percentage
// (PlatformSettings.commissionPercentage), and each PROPERTY (not landlord —
// each property has its own paybill, so commission is tracked per property)
// owes that percentage of whatever rent was actually collected for it in a
// given month, across ALL payment methods (cash, bank, mpesa, other).
//
// getPlatformSettings() is a singleton fetch-or-create — there is only ever
// one PlatformSettings document.
//
// computeCommissionForProperty() is the SINGLE source of truth for "how much
// is owed" — both the summary endpoint (what the landlord sees) and the pay
// endpoint (what actually gets sent to Safaricom) call this same function,
// so the displayed amount and the charged amount can never drift apart.

async function getPlatformSettings() {
    let settings = await PlatformSettings.findOne();
    if (!settings) {
        settings = await PlatformSettings.create({ commissionPercentage: 0 });
    }
    return settings;
}

// ── "Due" must only ever mean a CLOSED month — never the one still in
//    progress. This is the single source of truth every due-amount check
//    below uses, so a landlord can never see a live, unfinished month
//    framed as something owed. ──
function getMonthLabel(offsetMonths = 0) {
    const d = new Date();
    d.setDate(1); // pin to day 1 first so month arithmetic never rolls over on 29/30/31
    d.setMonth(d.getMonth() + offsetMonths);
    return d.toLocaleString('default', { month: 'long', year: 'numeric' });
}



async function computeCommissionForProperty(propertyId, month) {
    const agg = await Payment.aggregate([
        {
            $match: {
                property: new mongoose.Types.ObjectId(propertyId),
                month,
                status: { $in: ['paid', 'partial'] } // same "actually collected" filter used everywhere else (arrears, dashboard)
            }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const totalCollected = agg[0]?.total || 0;
    const settings        = await getPlatformSettings();
    const percentage      = settings.commissionPercentage;

    // Safaricom requires a whole-number STK amount — round up so a
    // fractional commission (e.g. 1234.50) never gets sent raw.
    const amountDue = Math.ceil(totalCollected * percentage / 100);

    return { totalCollected, percentage, amountDue };
}

// ── Finds every closed month, for a given property, where commission is
//    still unpaid AND the 7-day grace period after that month's close has
//    fully elapsed. Reuses computeCommissionForProperty as the single
//    source of truth so "overdue" can never drift from "due". Driven off
//    actual rent-collection months (Payment.distinct) rather than a fixed
//    calendar walk, so it naturally covers any number of missed months. ──
async function getOverdueCommissionMonths(propertyId, graceDays = 7) {
    const months = await Payment.distinct('month', {
        property: propertyId,
        status:   { $in: ['paid', 'partial'] }
    });

    const overdue = [];
    const now = Date.now();

    for (const month of months) {
        const monthDate = new Date(month); // "May 2026" parses to May 1, 2026
        if (isNaN(monthDate.getTime())) continue;

        // A month "closes" the instant the next month begins.
        const monthCloseDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1);
        const graceEndsAt    = monthCloseDate.getTime() + graceDays * 24 * 60 * 60 * 1000;
        if (now < graceEndsAt) continue; // month not closed yet, or still in grace

        const { amountDue } = await computeCommissionForProperty(propertyId, month);
        if (amountDue <= 0) continue;

        const paid = await CommissionPayment.findOne({ property: propertyId, month, status: 'paid' });
        if (paid) continue;

        overdue.push({ month, amountDue });
    }

    return overdue;
}

// ── Restores a system-suspended property the moment nothing is overdue
//    anymore. Never touches a property a stacklord suspended manually for
//    a different reason — that stays a human decision. ──
async function maybeAutoUnsuspendProperty(propertyId) {
    try {
        const property = await Property.findById(propertyId);
        if (!property || !property.isSuspended || property.suspendedBy !== 'system') return;

        const overdue = await getOverdueCommissionMonths(propertyId, 7);
        if (overdue.length) return; // still owes something

        property.isSuspended     = false;
        property.suspendedReason = null;
        property.suspendedAt     = null;
        property.suspendedBy     = null;
        await property.save();

        logActivity({
            landlord: property.landlord,
            property: property._id,
            action:   'property.auto_unsuspended',
            message:  `${property.name} automatically restored — commission settled`,
            actor:    'system'
        });
    } catch (err) {
        console.error('maybeAutoUnsuspendProperty error:', err.message);
    }
}

// ═══════════════════════════════════════
// M-PESA ENVIRONMENT CONFIG (FIX: sandbox was hardcoded everywhere)
// ═══════════════════════════════════════
//
// Set MPESA_ENV=production on Render once you have live Daraja credentials
// and a real paybill per property. Defaults to sandbox so nothing goes live
// by accident. Every STK push / OAuth / query call below now uses
// MPESA_BASE_URL instead of a hardcoded host.
//
// Render env vars you'll need:
//   MPESA_ENV               = sandbox | production
//   MPESA_CALLBACK_SECRET   = a long random string (openssl rand -hex 32)
//   MPESA_CALLBACK_URL      = https://<your-render-service>.onrender.com/callback/<MPESA_CALLBACK_SECRET>
//   BASE_URL                = https://<your-render-service>.onrender.com
//   SYSTEM_PAYBILL / SYSTEM_CONSUMER_KEY / SYSTEM_CONSUMER_SECRET / SYSTEM_PASSKEY
//                            = your (the platform owner's) own Paybill — this is
//                              where commission STK pushes land.
// ═══════════════════════════════════════

const MPESA_BASE_URL = process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// ── Normalize any Kenyan phone format to 254XXXXXXXXX ── (FIX: phone wasn't normalized before STK push)
// Safaricom requires PartyA/PhoneNumber in 254XXXXXXXXX format. Tenants/landlords
// naturally type 07XXXXXXXX or +254XXXXXXXXX — this converts either into what
// Daraja expects, so pushes stop silently failing on unnormalized numbers.
function normalizePhone(phone) {
    let p = String(phone || '').replace(/\s+/g, '').replace(/\+/g, '');
    if (p.startsWith('0')) p = '254' + p.slice(1);
    if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
    return p;
}


// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'No token' });

    // FIX Bug 23: guard against undefined JWT_SECRET
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('FATAL: JWT_SECRET is not set');
        return res.status(500).json({ message: 'Server configuration error' });
    }

    try {
        const token   = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, secret);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid token' });
    }
}

// ── Login rate limit: 5 attempts per 15 min per email+IP pair ──
const loginRateLimit = new Map();

function checkLoginRateLimit(key) {
    const now    = Date.now();
    const window = 15 * 60 * 1000;
    const max    = 5;

    const entry = loginRateLimit.get(key);
    if (!entry || (now - entry.windowStart) > window) {
        loginRateLimit.set(key, { count: 1, windowStart: now });
        return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
}


function landlordOnly(req, res, next) {
    if (req.user.role !== 'landlord') {
        return res.status(403).json({ message: 'Landlords only' });
    }
    next();
}

// ── FIX (plans → commission migration): replaces checkSubscription.
// The platform is free forever now, so this ONLY checks the moderation
// suspend switch — no more trial/grace/expired billing lifecycle. ──
async function checkAccountStatus(req, res, next) {
    if (req.user.role !== 'landlord') return next();

    try {
        const landlord = await User.findById(req.user.id).select('accountStatus suspendedReason');
        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        if (landlord.accountStatus === 'suspended') {
            return res.status(403).json({
                message:       `Your account has been suspended. Reason: ${landlord.suspendedReason || 'Contact support.'}`,
                accountStatus: 'suspended',
                code:          'ACCOUNT_SUSPENDED'
            });
        }

        return next();
    } catch (err) {
        console.error('checkAccountStatus error:', err.message);
        next();
    }
}


// ── Blocks growth actions (new tenants, new houses) on a property that's
//    currently suspended for unpaid commission. Does NOT block payment
//    recording or STK push — a suspended property must still be able to
//    collect rent so the landlord can pay down what's owed. ──
async function checkPropertySuspension(req, res, next) {
    try {
        const propertyId = req.body.propertyId || req.params.propertyId || req.query.propertyId;
        if (!propertyId) return next();

        // Scoped to req.user.id — a property that isn't theirs now just
        // falls through silently, and the route's own findOne({..., landlord})
        // check produces the 404. No more cross-landlord existence/suspension leak.
        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id })
            .select('isSuspended suspendedReason name');

        if (property && property.isSuspended) {
            return res.status(403).json({
                message: `${property.name} is suspended — ${property.suspendedReason || 'unpaid commission'}. Settle the balance from the Commission panel to restore access.`,
                code:    'PROPERTY_SUSPENDED'
            });
        }
        next();
    } catch (err) {
        console.error('checkPropertySuspension error:', err.message);
        next();
    }
}

// FIX Bug 20: timing-safe stacklord key comparison
function stacklordAuth(req, res, next) {
    const key       = req.headers['x-stacklord-key'];   // ← removed `|| req.query.key`
    const serverKey = process.env.STACKLORD_KEY;
    // ... rest unchanged


    if (!key || !serverKey) {
        return res.status(401).json({ message: 'Unauthorized — Stacklord access only 🔒' });
    }

    try {
        const keyBuf    = Buffer.from(key);
        const serverBuf = Buffer.from(serverKey);

        // Buffers must be same length for timingSafeEqual
        if (keyBuf.length !== serverBuf.length) {
            return res.status(401).json({ message: 'Unauthorized — Stacklord access only 🔒' });
        }

        if (!crypto.timingSafeEqual(keyBuf, serverBuf)) {
            return res.status(401).json({ message: 'Unauthorized — Stacklord access only 🔒' });
        }
    } catch {
        return res.status(401).json({ message: 'Unauthorized — Stacklord access only 🔒' });
    }

    next();
}

// ── Helper: validate property belongs to landlord ──
async function validateProperty(propertyId, landlordId) {
    if (!propertyId) return null;
    return await Property.findOne({ _id: propertyId, landlord: landlordId });
}


// ═══════════════════════════════════════
// M-PESA HELPERS
// ═══════════════════════════════════════

async function getRentToken(credentialHolder) {
    const consumerKey    = decrypt(credentialHolder.mpesaConsumerKey);
    const consumerSecret = decrypt(credentialHolder.mpesaConsumerSecret);

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    const res = await axios.get(
        `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` } }
    );
    return res.data.access_token;
}

// Used for platform-owned STK pushes — now exclusively the commission flow
// (previously also used for the old subscription flow).
async function getSystemToken() {
    const auth = Buffer.from(
        `${process.env.SYSTEM_CONSUMER_KEY}:${process.env.SYSTEM_CONSUMER_SECRET}`
    ).toString('base64');

    const res = await axios.get(
        `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` } }
    );
    return res.data.access_token;
}

// ── FIX Bug 14: real callback authentication ──
// IP-allowlisting was a no-op whenever SAFARICOM_ALLOWED_IPS wasn't set — which
// meant anyone who found/guessed a checkoutRequestId could POST straight to
// /callback and mark a rent payment "paid" with no real M-Pesa transaction.
// Render (like most PaaS) also doesn't guarantee a fixed IP Safaricom would see
// on the way in, so IP checking is unreliable either way.
//
// Real fix: a random secret embedded in the callback URL path itself
// (/callback/:secret). Safaricom just echoes back whatever CallBackURL you
// gave it, so this works regardless of hosting platform and can't be
// bypassed by guessing a checkoutRequestId. Reused as-is for the commission
// callback path below — same secret, same guarantee.
function validateCallbackSecret(req, res) {
    const configured = process.env.MPESA_CALLBACK_SECRET;
    if (!configured) {
        // Fail closed: refuse callbacks rather than silently trusting anyone,
        // if you forgot to set this env var.
        console.error('FATAL: MPESA_CALLBACK_SECRET is not set — rejecting callback');
        res.status(500).end();
        return false;
    }

    const provided = req.params.secret || '';
    const a = Buffer.from(provided);
    const b = Buffer.from(configured);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn('⚠️  Callback rejected — invalid or missing secret');
        res.status(404).end(); // 404, not 401 — don't confirm the route exists
        return false;
    }

    return true;
}


// ═══════════════════════════════════════
// MAINTENANCE MODE (per-landlord)
// ═══════════════════════════════════════

app.get('/maintenance', authMiddleware, async (req, res) => {
    try {
        let landlordId = req.user.id;
        if (req.user.role === 'tenant') {
            landlordId = req.user.landlordId;
        }

        const settings = await Settings.findOne({ landlord: landlordId });
        if (!settings) return res.json({ maintenanceMode: false, maintenanceMessage: '' });

        res.json({
            maintenanceMode:    settings.maintenanceMode,
            maintenanceMessage: settings.maintenanceMessage
        });
    } catch (err) {
        res.json({ maintenanceMode: false, maintenanceMessage: '' });
    }
});

app.put('/maintenance', authMiddleware, landlordOnly, async (req, res) => {
    try {
        // FIX Bug 22: sanitize text inputs
        const maintenanceMode    = Boolean(req.body.maintenanceMode);
        const maintenanceMessage = sanitize(req.body.maintenanceMessage || '', 500)
            || 'The system is currently under maintenance. Please check back later.';

        const settings = await Settings.findOneAndUpdate(
            { landlord: req.user.id },
            { maintenanceMode, maintenanceMessage, updatedAt: new Date() },
            { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
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
// PLATFORM-WIDE MAINTENANCE (kill switch)
// ═══════════════════════════════════════
// Separate from per-landlord Settings.maintenanceMode above — this is a
// single global flag, controlled only by the stacklord, that takes the
// ENTIRE platform down (landlord + tenant + public) for planned downtime.
//
// Allowlisted so the console stays reachable to turn it back off, the
// public status endpoint always answers, and M-Pesa callbacks are never
// dropped mid-reconciliation:
const PLATFORM_MAINTENANCE_ALLOWLIST = [
    /^\/stacklord(\/|$)/,
    /^\/platform-status$/,
    /^\/callback\//,
    /^\/commission-callback\//
];

app.use(async (req, res, next) => {
    if (PLATFORM_MAINTENANCE_ALLOWLIST.some(rx => rx.test(req.path))) return next();

    try {
        const settings = await getPlatformSettings();
        if (settings.platformMaintenanceMode) {
            return res.status(503).json({
                message: settings.platformMaintenanceMessage
                    || 'Affordable Rentals is temporarily down for maintenance. Please check back shortly.',
                code: 'PLATFORM_MAINTENANCE'
            });
        }
        next();
    } catch (err) {
        // Fail open — a DB hiccup here should never take the whole platform down
        console.error('Platform maintenance check error:', err.message);
        next();
    }
});

// Public — polled by the frontend to show a lock screen before login even loads
app.get('/platform-status', async (req, res) => {
    try {
        const settings = await getPlatformSettings();
        res.json({
            maintenanceMode: !!settings.platformMaintenanceMode,
            message:         settings.platformMaintenanceMessage || null
        });
    } catch (err) {
        res.json({ maintenanceMode: false, message: null });
    }
});


// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════

app.post('/landlord/register', async (req, res) => {
    try {
        // FIX Bug 22: sanitize all inputs
        const name             = sanitize(req.body.name || '');
        const email            = sanitize(req.body.email || '').toLowerCase();
        const password         = req.body.password || '';
        const phone            = sanitize(req.body.phone || '');
        const propertyName     = sanitize(req.body.propertyName || '');
        const propertyLocation = sanitize(req.body.propertyLocation || '');

        // FIX: server-side terms gate — the frontend checkbox is a UX nicety,
        // not a guarantee. Anyone hitting this endpoint directly (curl/Postman/
        // a modified client) could otherwise register without ever agreeing to
        // the Terms of Service / Privacy Policy. Coerce strictly to boolean true
        // so anything other than an explicit `true` is rejected.
        const termsAccepted = req.body.termsAccepted === true;

        if (!name || !email || !password || !phone || !propertyName || !propertyLocation) {
            return res.status(400).json({ message: 'All fields are required' });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }
        if (!termsAccepted) {
            return res.status(400).json({ message: 'You must agree to the Terms of Service and Privacy Policy to register' });
        }

        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ message: 'An account with this email already exists' });

        const hashedPassword = await bcrypt.hash(password, 10);

        // FIX Bug 23: guard JWT_SECRET
        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ message: 'Server configuration error' });

        // FIX (plans → commission migration): no more trial/plan assignment —
        // registration just creates the landlord with default accountStatus 'active'.
        const landlord = await User.create({
            name,
            email,
            password:           hashedPassword,
            role:               'landlord',
            phone,
            propertyName,
            propertyLocation,
            onboardingComplete: false,
            paymentConfigured:  false,
            // FIX: durable proof of consent — when, and against which terms version
            termsAcceptedAt:    new Date(),
            termsVersion:       process.env.TERMS_VERSION || '1.0'
        });

        await Settings.create({ landlord: landlord._id });

        const property = await Property.create({
        landlord: landlord._id,
        name:     propertyName,
        location: propertyLocation,
        phone:    phone
    });

    const token = jwt.sign(
                { id: landlord._id, role: landlord.role },
                secret,
                { expiresIn: '2h' } // FIX: shortened from 7d — sliding session via /auth/refresh-token keeps active users logged in
            );

            // Fire-and-forget — never block registration on email delivery
            sendLandlordWelcomeEmail({
                name:             landlord.name,
                email:            landlord.email,
                propertyName:     property.name,
                propertyLocation: property.location
            }).catch(err => console.error('Landlord welcome email failed:', err.message));

    

                res.status(201).json({
                    message:            'Account created successfully 🎉',
                    token,
                    onboardingComplete: false,
                    paymentConfigured:  false,
                    landlord: {
                        id:               landlord._id,
                        name:             landlord.name,
                        email:            landlord.email,
                        propertyName:     landlord.propertyName,
                        propertyLocation: landlord.propertyLocation
                    },
                    property: {
                        id:       property._id,
                        name:     property.name,
                        location: property.location
                    }
                });

            } catch (err) {
                console.error('Landlord register error:', err.message);
                res.status(500).json({ message: 'Registration failed — ' + err.message });
    }
});

app.post('/login', async (req, res) => {
    try {
        const email    = sanitize(req.body.email || '').toLowerCase();
        const password = req.body.password || '';

        // ← INSERT: rate-limit check, right after email is parsed
        const rlKey = `${email}:${req.ip}`;
        if (!checkLoginRateLimit(rlKey)) {
            return res.status(429).json({ message: 'Too many login attempts. Please wait 15 minutes and try again.' });
        }

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: 'Invalid email or password' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid email or password' });

        if (user.role === 'landlord' && user.accountStatus === 'suspended') {
            return res.status(403).json({
                message: `Your account has been suspended. Reason: ${user.suspendedReason || 'Contact support.'}`,
                code:    'ACCOUNT_SUSPENDED'
            });
        }

        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ message: 'Server configuration error' });

        if (user.role === 'tenant' && user.mustChangePassword) {
            // ← INSERT: clear rate limit here too — this branch also means
            // the password was correct, so it's a legitimate login
            loginRateLimit.delete(rlKey);

            const tempToken = jwt.sign(
                { id: user._id, role: user.role, tenantId: user.tenantId, mustChangePassword: true, landlordId: user.landlordId },
                secret,
                { expiresIn: '1h' }
            );
            return res.json({
                mustChangePassword: true,
                token:              tempToken,
                message:            'You must change your password before continuing.'
            });
        }

        // ← INSERT: main success path — clear it here, right before signing the real token
        loginRateLimit.delete(rlKey);

        const token = jwt.sign(
            {
                id:         user._id,
                role:       user.role,
                tenantId:   user.tenantId   || null,
                landlordId: user.landlordId || null
            },
            secret,
            { expiresIn: '2h' }
        );

        const response = { token };

        if (user.role === 'landlord') {
            const properties = await Property.find({ landlord: user._id })
                .select('name location paymentConfigured isActive')
                .sort({ createdAt: 1 });

            response.onboardingComplete = user.onboardingComplete;
            response.paymentConfigured  = user.paymentConfigured;
            response.landlord = {
                id:               user._id,
                name:             user.name,
                propertyName:     user.propertyName,
                propertyLocation: user.propertyLocation
            };
            response.properties = properties;
        }

        res.json(response);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/force-change-password', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant') {
            return res.status(403).json({ message: 'Tenants only' });
        }

        const newPassword = req.body.newPassword || '';
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        user.password           = await bcrypt.hash(newPassword, 10);
        user.mustChangePassword = false;
        await user.save();

        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ message: 'Server configuration error' });

        const token = jwt.sign(
            {
                id:         user._id,
                role:       user.role,
                tenantId:   user.tenantId   || null,
                landlordId: user.landlordId || null
            },
            secret,
            { expiresIn: '2h' } // FIX: shortened from 7d — matches login token lifetime
        );

        res.json({ message: 'Password updated successfully ✅', token });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════
// SESSION REFRESH (extend session on activity)
// ═══════════════════════════════════════
//
// Called by the frontend session-manager widget when the user clicks
// "Extend Session" on the idle-timeout warning modal. authMiddleware has
// already verified the CURRENT token is valid (not expired, correctly
// signed) before this handler runs — so this simply re-issues a fresh
// token with the same identity payload and a new 2h clock.
//
// If the token has already expired, authMiddleware rejects with 401
// before this route body ever runs — which is correct: an expired
// session cannot extend itself, the user must log in again.
app.post('/auth/refresh-token', authMiddleware, async (req, res) => {
    try {
        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ message: 'Server configuration error' });

        // Re-verify the user still exists and isn't suspended before extending —
        // covers the edge case where a landlord gets suspended mid-session.
        const user = await User.findById(req.user.id).select('role accountStatus suspendedReason tenantId landlordId');
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (user.role === 'landlord' && user.accountStatus === 'suspended') {
            return res.status(403).json({
                message: `Your account has been suspended. Reason: ${user.suspendedReason || 'Contact support.'}`,
                code:    'ACCOUNT_SUSPENDED'
            });
        }

        const token = jwt.sign(
            {
                id:         user._id,
                role:       user.role,
                tenantId:   user.tenantId   || null,
                landlordId: user.landlordId || null
            },
            secret,
            { expiresIn: '2h' }
        );

        res.json({ token, expiresIn: 7200 }); // seconds, for the frontend countdown to sync against

    } catch (err) {
        console.error('Refresh token error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Lightweight session status check — no DB hit, no token reissue.
//    Frontend polls this to drive a countdown display; it calls
//    /auth/refresh-token separately only when the user actually wants
//    to extend. authMiddleware has already verified the token, so
//    req.user carries the JWT's own `exp` claim. ──
app.get('/auth/session-status', authMiddleware, (req, res) => {
    const expiresAt = req.user.exp ? req.user.exp * 1000 : null;
    res.json({
        expiresAt,
        secondsRemaining: expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : null
    });
});

app.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const currentPassword = req.body.currentPassword || '';
        const newPassword     = req.body.newPassword     || '';

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

// FIX Bug 6: verify the tenant belongs to the active property the landlord manages
app.post('/reset-password', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenantId    = req.body.tenantId    || '';
        const newPassword = req.body.newPassword || '';

        if (!tenantId || !newPassword) {
            return res.status(400).json({ message: 'tenantId and newPassword required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        // Verify tenant belongs to this landlord (multi-property: any of their properties)
        const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const user = await User.findOne({ tenantId });
        if (!user) return res.status(404).json({ message: 'No user account found for this tenant' });

        user.password           = await bcrypt.hash(newPassword, 10);
        user.mustChangePassword = true;
        await user.save();

        res.json({ message: 'Password reset successfully ✅' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// FORGOT PASSWORD (3-step OTP flow)
// ═══════════════════════════════════════

// FIX Bug 5: rate-limit OTP requests to 3 per 15-min window per email
function checkOtpRateLimit(email) {
    const now    = Date.now();
    const window = 15 * 60 * 1000; // 15 minutes
    const max    = 3;

    const entry = otpRateLimit.get(email);

    if (!entry || (now - entry.windowStart) > window) {
        otpRateLimit.set(email, { count: 1, windowStart: now });
        return true;
    }

    if (entry.count >= max) return false;

    entry.count++;
    return true;
}

app.post('/forgot-password', async (req, res) => {
    try {
        const email = sanitize(req.body.email || '').toLowerCase();
        if (!email) return res.status(400).json({ message: 'Email is required' });

        // FIX Bug 5: rate limit
        if (!checkOtpRateLimit(email)) {
            return res.status(429).json({ message: 'Too many reset attempts. Please wait 15 minutes before trying again.' });
        }

        const user = await User.findOne({ email });
        // Always return same message to avoid email enumeration
        if (!user) return res.json({ message: 'If this email exists, a reset code has been sent.' });

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

app.post('/verify-reset-code', async (req, res) => {
    try {
        const email = sanitize(req.body.email || '').toLowerCase();
        const code  = req.body.code || '';
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

app.post('/reset-password-confirm', async (req, res) => {
    try {
        const email       = sanitize(req.body.email || '').toLowerCase();
        const code        = req.body.code        || '';
        const newPassword = req.body.newPassword || '';

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
        otpRateLimit.delete(email); // reset rate limit after successful reset
        res.json({ message: 'Password reset successfully ✅' });

    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ message: 'Password reset failed. Try again.' });
    }
});


// ═══════════════════════════════════════
// LANDLORD PROFILE & ONBOARDING
// ═══════════════════════════════════════

app.get('/landlord/profile', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const landlord = await User.findById(req.user.id)
            .select('-password -mpesaConsumerKey -mpesaConsumerSecret -mpesaPasskey');

        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

            const properties = await Property.find({ landlord: req.user.id })
            .select('name location phone paymentConfigured isActive paybillNumber isSuspended suspendedReason')
            .sort({ createdAt: 1 });

        res.json({
            id:                 landlord._id,
            name:               landlord.name,
            email:              landlord.email,
            phone:              landlord.phone,
            propertyName:       landlord.propertyName,
            propertyLocation:   landlord.propertyLocation,
            subdomain:          landlord.subdomain,
            onboardingComplete: landlord.onboardingComplete,
            paymentConfigured:  landlord.paymentConfigured,
            paybillNumber:      landlord.paybillNumber,
            accountStatus:      landlord.accountStatus,
            properties
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/landlord/profile', authMiddleware, landlordOnly, async (req, res) => {
    try {
        // FIX Bug 22: whitelist and sanitize fields
        const name             = sanitize(req.body.name             || '');
        const phone            = sanitize(req.body.phone            || '');
        const propertyName     = sanitize(req.body.propertyName     || '');
        const propertyLocation = sanitize(req.body.propertyLocation || '');

        const updated = await User.findByIdAndUpdate(
            req.user.id,
            { $set: { name, phone, propertyName, propertyLocation } },
            { returnDocument: "after", runValidators: true }
        ).select('-password -mpesaConsumerKey -mpesaConsumerSecret -mpesaPasskey');

        res.json({ message: 'Profile updated ✅', landlord: updated });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/landlord/complete-onboarding', authMiddleware, landlordOnly, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user.id, { onboardingComplete: true });
        res.json({ message: 'Onboarding complete ✅', onboardingComplete: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// FIX: rate-limit payment-credential OTP requests to 3 per 24-hour window
function checkPayOtpRateLimit(landlordId) {
const now    = Date.now();
const window = 24 * 60 * 60 * 1000; // 24 hours
const max    = 3;

const key   = String(landlordId);
const entry = payOtpRateLimit.get(key);

if (!entry || (now - entry.windowStart) > window) {
    payOtpRateLimit.set(key, { count: 1, windowStart: now });
    return true;
}

if (entry.count >= max) return false;

entry.count++;
return true;
}

app.post('/landlord/payment-otp', authMiddleware, landlordOnly, async (req, res) => {
try {
if (!checkPayOtpRateLimit(req.user.id)) {
return res.status(429).json({
success: false,
message: 'You have reached the maximum of 3 OTP requests in 24 hours. Please try again later.'
});
}

const landlord = await User.findById(req.user.id).select('name email');
    if (!landlord) return res.status(404).json({ success: false, message: 'Landlord not found' });

    const code      = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

    payOtpStore.set(String(req.user.id), { code, expiresAt });

    await sendPaymentOtpEmail({ name: landlord.name, email: landlord.email, code });

    res.json({ success: true, message: 'OTP sent to your email 📧' });

} catch (err) {
    console.error('Payment OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
}
});

app.post('/landlord/setup-payments', authMiddleware, landlordOnly, async (req, res) => {

try {

    const { paybillNumber, consumerKey, consumerSecret, passkey, propertyId, otp } = req.body;

        if (!paybillNumber || !consumerKey || !consumerSecret || !passkey || !propertyId) {
                return res.status(400).json({ message: 'All payment fields and propertyId are required' });
            }

    const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });

    // ── Editing existing credentials requires OTP + 30-day cooldown ──
            if (property.paymentConfigured) {
                if (property.paymentLastUpdated) {
                    const daysSince = (Date.now() - new Date(property.paymentLastUpdated).getTime()) / (1000 * 60 * 60 * 24);
                    if (daysSince < 30) {
                        const nextAllowed = new Date(new Date(property.paymentLastUpdated).getTime() + 30 * 24 * 60 * 60 * 1000);
                        return res.status(403).json({
                            message: `Credentials were recently updated. Next update allowed on ${nextAllowed.toDateString()}.`
                        });
                    }
                }

                if (!otp) {
                    return res.status(401).json({ message: 'OTP verification required to update credentials' });
                }

        const entry = payOtpStore.get(String(req.user.id));
                    if (!entry) {
                        return res.status(401).json({ message: 'No OTP request found. Please request a new OTP.' });
                    }
                    if (Date.now() > entry.expiresAt) {
                        payOtpStore.delete(String(req.user.id));
                        return res.status(401).json({ message: 'OTP has expired. Please request a new one.' });
                    }
                    if (entry.code !== otp.toString()) {
                        return res.status(401).json({ message: 'Invalid OTP code.' });
                    }

                    // OTP valid — consume it so it cannot be reused
                    payOtpStore.delete(String(req.user.id));
                }

                property.paybillNumber       = sanitize(paybillNumber);
                property.mpesaConsumerKey    = encrypt(consumerKey);
                property.mpesaConsumerSecret = encrypt(consumerSecret);
                property.mpesaPasskey        = encrypt(passkey);
                property.paymentConfigured   = true;
                property.paymentLastUpdated  = new Date();
                await property.save();

                await User.findByIdAndUpdate(req.user.id, {
                    paymentConfigured:  true,
                    onboardingComplete: true
                });

            res.json({
                message:           'Payment credentials saved securely ✅',
                paymentConfigured: true,
                property: {
                    id:                 property._id,
                    name:               property.name,
                    paymentLastUpdated: property.paymentLastUpdated
                }

             });

        } catch (err) {
            console.error('Setup payments error:', err.message);
            res.status(500).json({ message: 'Failed to save payment credentials' });
    }
});


// ═══════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════

// FIX (plans → commission migration): no more maxProperties enforcement —
// landlords can add unlimited properties, it's free.
app.post('/properties/create', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const name     = sanitize(req.body.name     || '');
        const location = sanitize(req.body.location || '');
        const phone    = sanitize(req.body.phone    || '');

        if (!name) return res.status(400).json({ message: 'Property name is required' });

        const exists = await Property.findOne({ landlord: req.user.id, name });
        if (exists) return res.status(400).json({ message: 'You already have a property with that name' });

        const property = await Property.create({
            landlord: req.user.id,
            name,
            location: location || null,
            phone:    phone    || null
        });

        res.status(201).json({ message: 'Property created ✅', property });

    } catch (err) {
        console.error('Create property error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/properties', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const properties = await Property.find({ landlord: req.user.id }).sort({ createdAt: 1 });
        res.json({ properties });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/properties/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });
        res.json({ property });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/properties/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        // FIX Bug 22: whitelist fields
        const name     = sanitize(req.body.name     || '');
        const location = sanitize(req.body.location || '');
        const phone    = sanitize(req.body.phone    || '');

        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (name)     property.name     = name;
        if (location) property.location = location;
        if (phone)    property.phone    = phone;

        await property.save();
        res.json({ message: 'Property updated ✅', property });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.put('/properties/:id/location', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });
 
        const lat     = Number(req.body.lat);
        const lng     = Number(req.body.lng);
        const address = typeof req.body.address === 'string' ? req.body.address : undefined;
 
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ message: 'lat and lng are required and must be numbers' });
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return res.status(400).json({ message: 'lat/lng out of valid range' });
        }
 
        const updated = await geocodeAndSaveProperty(property._id, { lat, lng, address });
 
        if (!updated) {
            // Coordinates were valid but we couldn't resolve/save — still a
            // real failure, not a 404/400, since the property does exist.
            return res.status(502).json({ message: 'Could not save location. Please try again.' });
        }
 
        res.json({
            message:  'Location saved ✅',
            property: {
                _id:              updated._id,
                geo:              updated.geo,
                formattedAddress: updated.formattedAddress,
                geocodedAt:       updated.geocodedAt
            }
        });
 
    } catch (err) {
        console.error('PUT /properties/:id/location error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// FIX Bug 7: cascade-delete all related data when property is deleted
app.delete('/properties/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const activeTenants = await Tenant.countDocuments({ property: req.params.id, status: 'active' });
        if (activeTenants > 0) {
            return res.status(400).json({
                message: `Cannot delete — ${activeTenants} active tenant(s) still assigned. Move them out first.`
            });
        }

        // Cascade delete all property-scoped data
        await Promise.all([
            House.deleteMany({ property: req.params.id }),
            Tenant.deleteMany({ property: req.params.id }),
            Payment.deleteMany({ property: req.params.id }),
            Rule.deleteMany({ property: req.params.id }),
            Announcement.deleteMany({ property: req.params.id }),
            Message.deleteMany({ property: req.params.id }),
            TenantMembership.deleteMany({ property: req.params.id }),
            CommissionPayment.deleteMany({ property: req.params.id }),
            MaintenanceRequest.deleteMany({ property: req.params.id })
        ]);

        await Property.findByIdAndDelete(req.params.id);
        res.json({ message: 'Property and all related data deleted ✅' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════

app.post('/tenants/create', authMiddleware, landlordOnly, checkAccountStatus, checkPropertySuspension, async (req, res) => {
    try {
        // FIX Bug 22: sanitize inputs
        const name       = sanitize(req.body.name  || '');
        const email      = sanitize(req.body.email || '').toLowerCase();
        const phone      = sanitize(req.body.phone || '');
        const dueDate    = req.body.dueDate    || 5;
        const houseId    = req.body.houseId    || null;
        const propertyId = req.body.propertyId || null;

        if (!name || !email || !phone) {
            return res.status(400).json({ message: 'name, email and phone are required' });
        }
        if (!propertyId) {
            return res.status(400).json({ message: 'propertyId is required' });
        }

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        // FIX (plans → commission migration): no more tenant-cap check — unlimited tenants per property.
        const landlordUser = await User.findById(req.user.id);

        const existingTenantHere = await Tenant.findOne({ property: propertyId, email });
        if (existingTenantHere) {
            if (existingTenantHere.status === 'moved_out') {
                return res.status(400).json({
                    message: 'This tenant has previously lived here. Use the Reactivate option from the Moved Out tab instead.'
                });
            }
            return res.status(400).json({ message: 'A tenant with this email already exists in this property' });
        }

        // Check if this email is currently active at ANY property
        const activeTenantElsewhere = await Tenant.findOne({ email, status: 'active' });
        if (activeTenantElsewhere) {
            const activeProp = await Property.findById(activeTenantElsewhere.property).select('name');
            return res.status(400).json({
                message: `This tenant is currently active at ${activeProp?.name || 'another property'}. They must be moved out first.`
            });
        }

        let house = null;
        if (houseId) {
            house = await House.findOne({ _id: houseId, property: propertyId, landlord: req.user.id });
            if (!house)                      return res.status(404).json({ message: 'House not found' });
            if (house.status === 'occupied') return res.status(400).json({ message: 'House is already occupied' });
        }

        const tenantData = {
            landlord: req.user.id,
            property: propertyId,
            name,
            email,
            phone,
            dueDate: Number(dueDate) || 5,
            ...(houseId && { house: houseId })
        };

        const tenant = await Tenant.create(tenantData);

        if (house) {
            await House.findByIdAndUpdate(houseId, { status: 'occupied' });
        }

        let isReturning = false;
        let userId;

        const existingUser = await User.findOne({ email });

        if (existingUser) {
            existingUser.landlordId = req.user.id;
            existingUser.tenantId   = tenant._id;
            existingUser.name       = name;
            await existingUser.save();
            isReturning = true;
            userId      = existingUser._id;
        } else {
            const tempPassword   = crypto.randomBytes(6).toString('base64').slice(0, 8);
            const hashedPassword = await bcrypt.hash(tempPassword, 10);

            const newUser = await User.create({
                name,
                email,
                password:           hashedPassword,
                role:               'tenant',
                tenantId:           tenant._id,
                landlordId:         req.user.id,
                mustChangePassword: true
            });

            userId = newUser._id;

            sendTenantWelcomeEmail({
                name,
                email,
                tempPassword,
                isReturning:  false,
                propertyName: property.name,
                landlordName: landlordUser.name
            }).catch(err => console.error('Welcome email failed:', err.message));
        }

        await TenantMembership.create({
            user:     userId,
            landlord: req.user.id,
            property: propertyId,
            tenant:   tenant._id,
            house:    houseId || null,
            status:   'active'
        });

                if (isReturning) {
            sendTenantWelcomeEmail({
                name, 
                email, 
                tempPassword: null, 
                isReturning: true,
                propertyName: property.name,
                 landlordName: landlordUser.name
            }).catch(err => console.error('Notification email failed:', err.message));
        }

        logActivity({
            landlord: req.user.id, property: propertyId,
            action:   isReturning ? 'tenant.readded' : 'tenant.created',
            message:  `${name} was ${isReturning ? 're-added to' : 'created for'} ${property.name}`,
            meta:     { tenantId: tenant._id }
        });
        res.status(201).json({
            message: isReturning
                ? 'Tenant added to your property. Notification email sent 📧'
                : 'Tenant account created. Welcome email sent 📧',
            tenant,
            isReturning
        });

    } catch (err) {
        console.error('Create tenant error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// FIX Bug 9: whitelist updatable fields to prevent overwriting sensitive data
app.put('/tenants/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        // Only allow safe fields to be updated
        const allowed = ['name', 'phone', 'dueDate'];
        const updates = {};
        for (const field of allowed) {
            if (req.body[field] !== undefined) {
                updates[field] = typeof req.body[field] === 'string'
                    ? sanitize(req.body[field])
                    : req.body[field];
            }
        }

        const updated = await Tenant.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { returnDocument: 'after', runValidators: true }
        );
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// ASSIGN HOUSE
// ═══════════════════════════════════════

app.put('/assign-house/:tenantId/:houseId', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: req.user.id });
        const house  = await House.findOne({ _id: req.params.houseId, landlord: req.user.id });

        if (!tenant || !house) {
            return res.status(404).json({ message: 'Tenant or House not found' });
        }

        if (house.status === 'occupied') {
            return res.status(400).json({ message: 'This house is already occupied ❌' });
        }

        const wasReactivation = tenant.status === 'moved_out';

        if (tenant.status === 'active') {
            if (String(tenant.property) !== String(house.property)) {
                return res.status(400).json({ message: 'House and tenant must belong to the same property' });
            }
            if (tenant.house) {
                return res.status(400).json({ message: 'Tenant already has a house assigned ❌' });
            }
        }

        // FIX Bug 1 + Bug 3: cross-landlord reactivation check
        if (tenant.status === 'moved_out') {
            // Block reactivation if this email is already active under a different landlord
            const activeTenantElsewhere = await Tenant.findOne({
                email:   tenant.email,
                status:  'active',
                _id:     { $ne: tenant._id }
            });
            if (activeTenantElsewhere) {
                const activeProp = await Property.findById(activeTenantElsewhere.property).select('name');
                return res.status(400).json({
                    message: `This tenant is currently active at ${activeProp?.name || 'another property'} and cannot be reactivated here.`
                });
            }

            tenant.status       = 'active';
            tenant.movedOutAt   = null;
            tenant.lastHouse    = null;
            tenant.lastProperty = null;
            tenant.lastLandlord = null;
            tenant.property     = house.property;

            // FIX Bug 2: re-link User account to this landlord
            await User.findOneAndUpdate(
                { tenantId: tenant._id },
                { landlordId: req.user.id }
            );

            // FIX Bug 11: use separate findOne + save instead of upsert with sort
            // to avoid the MongoDB upsert+sort unreliability
            const existingMembership = await TenantMembership.findOne({
                tenant:   tenant._id,
                landlord: req.user.id
            }).sort({ createdAt: -1 });

            if (existingMembership) {
                existingMembership.property = house.property;
                existingMembership.house    = house._id;
                existingMembership.status   = 'active';
                existingMembership.joinedAt = new Date();
                existingMembership.leftAt   = null;
                await existingMembership.save();
            } else {
                await TenantMembership.create({
                    user:     (await User.findOne({ tenantId: tenant._id }).select('_id'))?._id,
                    landlord: req.user.id,
                    property: house.property,
                    tenant:   tenant._id,
                    house:    house._id,
                    status:   'active',
                    joinedAt: new Date(),
                    leftAt:   null
                });
            }
        }

        tenant.house = house._id;
        house.status = 'occupied';

        await tenant.save();
        await house.save();

        logActivity({
            landlord: req.user.id, property: house.property,
            action:   wasReactivation ? 'tenant.reactivated' : 'tenant.assigned',
            message:  `${tenant.name} assigned to ${house.name}`,
            meta:     { tenantId: tenant._id, houseId: house._id }
        });

        // FIX Bug 12: only update membership for fresh (non-reactivated) active assignments
        // Reactivation path already handled the membership update above
        if (tenant.status === 'active' && !tenant.isNew) {
            await TenantMembership.findOneAndUpdate(
                { tenant: tenant._id, status: 'active', landlord: req.user.id },
                { house: house._id }
            );
        }

        res.json({ message: 'House assigned successfully ✅', tenant, house });

    } catch (err) {
        console.error('assign-house error:', err);
        res.status(500).json({ message: err.message });
    }
});


// ═══════════════════════════════════════
// MOVE OUT
// ═══════════════════════════════════════

// FIX Bug 10: guard against calling move-out on already moved-out tenant
app.put('/move-out/:tenantId', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: req.user.id });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        // FIX Bug 10
        if (tenant.status === 'moved_out') {
            return res.status(400).json({ message: 'Tenant has already been moved out' });
        }
        if (!tenant.house) return res.status(400).json({ message: 'This tenant is not assigned to any house' });

        const house = await House.findOne({ _id: tenant.house, landlord: req.user.id });
        if (!house) return res.status(404).json({ message: 'House not found' });

        tenant.lastHouse    = tenant.house;
        tenant.lastProperty = tenant.property;
        tenant.lastLandlord = tenant.landlord;
        tenant.status       = 'moved_out';
        tenant.movedOutAt   = new Date();
        tenant.house        = null;

        house.status = 'available';

        await User.findOneAndUpdate(
            { tenantId: tenant._id },
            { landlordId: null }
        );

        await TenantMembership.findOneAndUpdate(
            { tenant: tenant._id, status: 'active' },
            { status: 'moved_out', leftAt: new Date() }
        );

        await house.save();
        await tenant.save();

        sendMoveOutEmail({
            name:        tenant.name,
            email:       tenant.email,
            house:       house.name,
            moveOutDate: new Date()
        }).catch(err => console.error('Move-out email failed:', err.message));

        res.json({ message: 'Tenant moved out successfully 🏠➡️🚪', tenant, house });

        logActivity({
            landlord: req.user.id, property: tenant.property,
            action:   'tenant.moved_out',
            message:  `${tenant.name} moved out of ${house.name}`,
            meta:     { tenantId: tenant._id, houseId: house._id }
        });

    } catch (err) {
        console.error('Move-out error:', err.message);
        res.status(500).json({ message: err.message });
    }
});


// ═══════════════════════════════════════
// DELETE TENANT
// ═══════════════════════════════════════

app.delete('/tenant/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (tenant.house) {
            await House.findOneAndUpdate(
                { _id: tenant.house, landlord: req.user.id },
                { status: 'available' }
            );
        }

        await TenantMembership.updateMany(
            { tenant: req.params.id },
            { status: 'moved_out', leftAt: new Date() }
        );

        await User.findOneAndUpdate(
            { tenantId: req.params.id },
            { tenantId: null, landlordId: null }
        );

        await tenant.deleteOne();

         logActivity({
            landlord: req.user.id, property: tenant.property,
            action:   'tenant.deleted',
            message:  `${tenant.name} was permanently deleted`,
            meta:     { tenantId: tenant._id }
        });

        res.json({ message: 'Tenant removed ✅' });

    } catch (err) {
        console.error('Delete tenant error:', err.message);
        res.status(500).json({ message: 'Error removing tenant ❌' });
    }
});


// ═══════════════════════════════════════
// GET TENANTS
// ═══════════════════════════════════════

app.get('/tenants', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'landlord') {
            const query = { landlord: req.user.id };

            const statusParam = req.query.status;
            if (!statusParam || statusParam === 'active') {
                query.status = 'active';
            } else if (statusParam === 'moved_out') {
                query.status = 'moved_out';
            }

            if (req.query.propertyId) {
                const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
                if (!property) return res.status(404).json({ message: 'Property not found' });
                query.property = req.query.propertyId;
            }

            const tenants = await Tenant.find(query)
                .populate('house')
                .populate('property', 'name')
                .populate('lastProperty', 'name')
                .populate('lastHouse', 'name');

            return res.json(tenants);
        }

        const tenant = await Tenant.findById(req.user.tenantId)
            .populate('house')
            .populate('property', 'name')
            .populate('lastProperty', 'name location')
            .populate('lastHouse', 'name rent');

        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        return res.json([tenant]);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/tenant/:id', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'tenant' && String(req.user.tenantId) !== req.params.id) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const query = req.user.role === 'landlord'
            ? { _id: req.params.id, landlord: req.user.id }
            : { _id: req.params.id };

        const tenant = await Tenant.findOne(query)
            .populate('house')
            .populate('property', 'name location')
            .populate('lastProperty', 'name location')
            .populate('lastHouse', 'name rent');

        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const payments  = await Payment.find({ tenant: tenant._id, status: { $in: ['paid', 'partial'] } });
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

        const rentSource = tenant.status === 'moved_out' ? tenant.lastHouse : tenant.house;
        const rent       = rentSource ? rentSource.rent : 0;

        const months        = new Set(payments.map(p => p.month)).size || 1;
        const expectedTotal = rent * months;
        const arrears       = Math.max(0, expectedTotal - totalPaid);

        res.json({ tenant, payments, totalPaid, arrears });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// HOUSES
// ═══════════════════════════════════════

app.post('/houses', authMiddleware, landlordOnly, checkAccountStatus, checkPropertySuspension, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || null;
        const name       = sanitize(req.body.name || '');
        const rent       = req.body.rent;

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const house = await House.create({
            name,
            rent,
            landlord: req.user.id,
            property: propertyId
        });

        res.status(201).json(house);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/houses', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'landlord') {
            const query = { landlord: req.user.id };

            if (req.query.propertyId) {
                const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
                if (!property) return res.status(404).json({ message: 'Property not found' });
                query.property = req.query.propertyId;
            }

           
            const houses = await House.find(query)
                .populate('property', 'name')
                .populate('group', 'label prefix padWidth colorIndex createdAt')
                .lean();
 
            houses.sort((a, b) => {
                const aTime = a.group?.createdAt || a.createdAt;
                const bTime = b.group?.createdAt || b.createdAt;
                const tDiff = new Date(aTime) - new Date(bTime);
                if (tDiff !== 0) return tDiff;
 
                const aSeq = a.groupSeq ?? null, bSeq = b.groupSeq ?? null;
                if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
 
                return a.name.localeCompare(b.name, undefined, { numeric: true });
            });
 
            return res.json(houses);
        }

        const tenant = await Tenant.findById(req.user.tenantId).populate('house');
        if (!tenant || !tenant.house) return res.json([]);
        return res.json([tenant.house]);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// FIX Bug 22: whitelist house update fields
app.put('/houses/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const allowed = ['name', 'rent'];
        const updates = {};
        for (const field of allowed) {
            if (req.body[field] !== undefined) {
                updates[field] = typeof req.body[field] === 'string'
                    ? sanitize(req.body[field])
                    : req.body[field];
            }
        }

        const updated = await House.findOneAndUpdate(
            { _id: req.params.id, landlord: req.user.id },
            { $set: updates },
            { returnDocument: 'after', runValidators: true }
        );
        if (!updated) return res.status(404).json({ message: 'House not found' });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── Preview only — no DB writes, used for the live preview panel ──
app.post('/houses/generate-preview', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const names = generateHouseNames(req.body.config || {});
        const seen  = new Set();
        const dupes = names.filter(n => seen.has(n) || !seen.add(n));
 
        res.json({
            names,
            count: names.length,
            hasDuplicatesInBatch: dupes.length > 0,
            duplicates: [...new Set(dupes)]
        });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// ── Actual bulk-create ──
app.post('/houses/generate', authMiddleware, landlordOnly, checkAccountStatus, checkPropertySuspension, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || null;
        const rent       = Number(req.body.rent);
 
        if (!propertyId)        return res.status(400).json({ message: 'propertyId is required' });
        if (!rent || rent <= 0) return res.status(400).json({ message: 'A valid rent amount is required' });
 
        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });
 
        const floors = Array.isArray(req.body.config?.floors) ? req.body.config.floors : [];
        if (!floors.length) return res.status(400).json({ message: 'At least one naming group is required' });
 
        // Build name/seq pairs per floor first, so we can validate the whole
        // batch (duplicates, size limits) before creating anything.
        let allPairs = [];
        const perFloorPairs = [];
        try {
            for (const floor of floors) {
                const pairs = buildFloorNamePairs(floor);
                perFloorPairs.push({ floor, pairs });
                allPairs = allPairs.concat(pairs);
            }
        } catch (err) {
            return res.status(400).json({ message: err.message });
        }
 
        if (!allPairs.length)      return res.status(400).json({ message: 'Configuration produced no unit names — check counts' });
        if (allPairs.length > 500) return res.status(400).json({ message: 'Cannot generate more than 500 units in one request' });
 
        const allNames = allPairs.map(p => p.name);
        if (new Set(allNames).size !== allNames.length) {
            return res.status(400).json({ message: 'Configuration produces duplicate names within the batch — adjust prefixes or start numbers' });
        }
 
        const existing = await House.find({ property: propertyId, name: { $in: allNames } }).select('name');
        if (existing.length) {
            const sample = existing.slice(0, 5).map(h => h.name).join(', ');
            return res.status(400).json({
                message: `${existing.length} name(s) already exist in this property: ${sample}${existing.length > 5 ? '…' : ''}`
            });
        }
 
        // Each floor/group in the request becomes its own HouseGroup document,
        // so it can be extended later and gets its own color.
        const existingGroupCount = await HouseGroup.countDocuments({ property: propertyId });
        let colorCursor = existingGroupCount;
 
        const createdHouses = [];
        for (const { floor, pairs } of perFloorPairs) {
            if (!pairs.length) continue;
 
            const group = await HouseGroup.create({
                landlord:   req.user.id,
                property:   propertyId,
                label:      sanitize(floor.label || floor.prefix || '', 60),
                prefix:     typeof floor.prefix === 'string' ? floor.prefix : '',
                padWidth:   Number.isFinite(Number(floor.padWidth)) ? Number(floor.padWidth) : 0,
                colorIndex: colorCursor % 8   // 8 = length of the frontend color palette
            });
            colorCursor++;
 
            const docs = pairs.map(p => ({
                name: p.name, rent, landlord: req.user.id, property: propertyId,
                group: group._id, groupSeq: p.seq
            }));
            const created = await House.insertMany(docs);
            createdHouses.push(...created);
        }
 
        logActivity({
            landlord: req.user.id, property: propertyId,
            action:  'houses.bulk_generated',
            message: `${createdHouses.length} units generated for ${property.name}`,
            meta:    { count: createdHouses.length }
        });
 
        res.status(201).json({ message: `${createdHouses.length} unit(s) created ✅`, count: createdHouses.length, houses: createdHouses });
 
    } catch (err) {
        console.error('generate houses error:', err.message);
        res.status(500).json({ message: err.message });
    }
});
 
 
// ── List existing groups for a property, with the next-available
//    number for each — powers the "Extend Existing Group" dropdown ──
app.get('/houses/groups', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const propertyId = req.query.propertyId;
        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });
 
        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });
 
        const groups = await HouseGroup.find({ property: propertyId, landlord: req.user.id }).sort({ createdAt: 1 });
 
        const enriched = await Promise.all(groups.map(async g => {
            const count     = await House.countDocuments({ group: g._id });
            const maxSeqDoc = await House.findOne({ group: g._id }).sort({ groupSeq: -1 }).select('groupSeq');
            const nextSeq   = (maxSeqDoc?.groupSeq ?? 0) + 1;
            const nextName  = g.padWidth > 0
                ? `${g.prefix}${String(nextSeq).padStart(g.padWidth, '0')}`
                : `${g.prefix}${nextSeq}`;
 
            return {
                _id: g._id, label: g.label, prefix: g.prefix, padWidth: g.padWidth,
                colorIndex: g.colorIndex, count, nextSeq, nextName
            };
        }));
 
        res.json({ groups: enriched });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});
 
// ── Extend an existing group — continues its numbering automatically,
//    so the landlord only says "add 2 more", never retypes prefix/padding ──
app.post('/houses/extend-group', authMiddleware, landlordOnly, checkAccountStatus, checkPropertySuspension, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || null;
        const groupId     = req.body.groupId    || null;
        const count       = Number(req.body.count);
        const rentInput   = req.body.rent !== undefined ? Number(req.body.rent) : null;
 
        if (!propertyId || !groupId) return res.status(400).json({ message: 'propertyId and groupId are required' });
        if (!count || count <= 0)    return res.status(400).json({ message: 'A valid unit count is required' });
        if (count > 500)             return res.status(400).json({ message: 'Cannot add more than 500 units at once' });
 
        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });
 
        const group = await HouseGroup.findOne({ _id: groupId, property: propertyId, landlord: req.user.id });
        if (!group) return res.status(404).json({ message: 'Group not found' });
 
        // If rent wasn't supplied, reuse the rent already used by this group
        // so the landlord doesn't have to remember/retype it.
        let finalRent = rentInput;
        if (!finalRent || finalRent <= 0) {
            const sample = await House.findOne({ group: group._id }).select('rent');
            finalRent = sample ? sample.rent : null;
        }
        if (!finalRent || finalRent <= 0) {
            return res.status(400).json({ message: 'A valid rent amount is required — could not infer one from this group' });
        }
 
        const maxSeqDoc = await House.findOne({ group: group._id }).sort({ groupSeq: -1 }).select('groupSeq');
        const startSeq  = (maxSeqDoc?.groupSeq ?? 0) + 1;
 
        const pairs = [];
        for (let i = 0; i < count; i++) {
            const num    = startSeq + i;
            const numStr = group.padWidth > 0 ? String(num).padStart(group.padWidth, '0') : String(num);
            pairs.push({ name: `${group.prefix}${numStr}`, seq: num });
        }
 
        const names    = pairs.map(p => p.name);
        const existing = await House.find({ property: propertyId, name: { $in: names } }).select('name');
        if (existing.length) {
            const sample = existing.slice(0, 5).map(h => h.name).join(', ');
            return res.status(400).json({ message: `${existing.length} name(s) already exist: ${sample}${existing.length > 5 ? '…' : ''}` });
        }
 
        const docs = pairs.map(p => ({
            name: p.name, rent: finalRent, landlord: req.user.id, property: propertyId,
            group: group._id, groupSeq: p.seq
        }));
        const created = await House.insertMany(docs);
 
        logActivity({
            landlord: req.user.id, property: propertyId,
            action:  'houses.bulk_generated',
            message: `${created.length} more unit(s) added to ${group.label || group.prefix} in ${property.name}`,
            meta:    { count: created.length, groupId: group._id }
        });
 
        res.status(201).json({ message: `${created.length} unit(s) added ✅`, count: created.length, houses: created });
 
    } catch (err) {
        console.error('extend group error:', err.message);
        res.status(500).json({ message: err.message });
    }
});


app.delete('/house/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const house = await House.findOne({ _id: req.params.id, landlord: req.user.id });
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


// ═══════════════════════════════════════
// PAYMENT HELPER
// ═══════════════════════════════════════

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

app.post('/payments', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const tenantId = req.body.tenantId || '';
        const amount   = Number(req.body.amount);
        const month    = sanitize(req.body.month  || '');
        const method   = req.body.method  || 'cash';
        const note     = sanitize(req.body.note   || '', 300);

        if (!tenantId || !amount || !month) {
            return res.status(400).json({ message: 'tenantId, amount and month are required' });
        }
        if (amount <= 0) {
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id }).populate('house');
        if (!tenant)       return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house assigned' });

        const rent    = tenant.house.rent;
        const summary = await getMonthSummary(tenantId, month, rent);

        if (summary.status === 'paid') {
            return res.status(400).json({ message: `Rent for ${month} is already fully paid ✅`, summary });
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
            landlord:   req.user.id,
            property:   tenant.property,
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

        doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);

        // Fire-and-forget — response is not blocked on email delivery
        sendRentReceiptEmail({
            tenant,
            house:     tenant.house,
            month,
            amount,
            rent,
            newTotalPaid,
            newBalance,
            newStatus,
            paymentId: payment._id,
            pdfBuffer: pdfData
        }).catch(err => console.error('Receipt email failed:', err.message));

        logActivity({
            landlord: req.user.id, property: tenant.property,
            action:   'payment.recorded',
            message:  `${tenant.name} paid Ksh ${Number(amount).toLocaleString()} for ${month}`,
            meta:     { paymentId: payment._id, amount, method, status: newStatus }
        });

        res.json({
            message:   `Payment recorded — ${newStatus.toUpperCase()} 📄`,
            paymentId: payment._id,
            payment,
            summary:   { rentAmount: rent, totalPaid: newTotalPaid, balance: newBalance, status: newStatus }
        });
    });

    } catch (err) {
        console.error('Payment error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/payments', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const query = { landlord: req.user.id };

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        }

        const payments = await Payment.find(query)
            .populate('tenant')
            .populate('house')
            .populate('property', 'name')
            .sort({ createdAt: -1 })
            .limit(200); // FIX Bug 17: cap result set

        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/payments/tenant/:tenantId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'tenant' && String(req.user.tenantId) !== req.params.tenantId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        if (req.user.role === 'landlord') {
            const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: req.user.id });
            if (!tenant) return res.status(403).json({ message: 'Forbidden' });
        }

        const payments = await Payment.find({ tenant: req.params.tenantId })
            .sort({ createdAt: -1 })
            .limit(200); // FIX Bug 17: pagination cap
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/payments/summary/:tenantId/:month', authMiddleware, async (req, res) => {
    try {
        const { tenantId, month } = req.params;

        if (req.user.role === 'tenant' && String(req.user.tenantId) !== tenantId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        if (req.user.role === 'landlord') {
            const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id });
            if (!tenant) return res.status(403).json({ message: 'Forbidden' });
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

app.get('/payments/months/:tenantId', authMiddleware, async (req, res) => {
    try {
        const { tenantId } = req.params;

        if (req.user.role === 'tenant' && String(req.user.tenantId) !== tenantId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        if (req.user.role === 'landlord') {
            const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id });
            if (!tenant) return res.status(403).json({ message: 'Forbidden' });
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

// FIX Bug 15: batch arrears calculation to avoid N+1 queries
app.get('/arrears', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const query        = { landlord: req.user.id, status: 'active' };
        const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        }

        const tenants = await Tenant.find(query).populate('house');

        // Batch fetch all relevant payments in one query
        const tenantIds = tenants.filter(t => t.house).map(t => t._id);
        const payments  = await Payment.find({
            tenant: { $in: tenantIds },
            month:  currentMonth,
            status: { $in: ['paid', 'partial'] }
        }).select('tenant amount');

        // Build paid map: tenantId -> totalPaid
        const paidMap = {};
        for (const p of payments) {
            const key = String(p.tenant);
            paidMap[key] = (paidMap[key] || 0) + p.amount;
        }

        const arrearsList = [];
        for (const tenant of tenants) {
            if (!tenant.house) continue;
            const rent      = tenant.house.rent;
            const totalPaid = paidMap[String(tenant._id)] || 0;
            const balance   = Math.max(0, rent - totalPaid);
            if (balance > 0) {
                arrearsList.push({
                    tenantId:  tenant._id,
                    tenant:    tenant.name,
                    email:     tenant.email,
                    house:     tenant.house.name,
                    month:     currentMonth,
                    rent,
                    totalPaid,
                    balance,
                    status:    totalPaid > 0 ? 'partial' : 'unpaid'
                });
            }
        }

        res.json(arrearsList);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// FIX Bug 15: batch arrears calculation for specific month too
app.get('/arrears/:month', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const month = req.params.month;
        const query = { landlord: req.user.id, status: 'active' };

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        }

        const tenants   = await Tenant.find(query).populate('house');
        const tenantIds = tenants.filter(t => t.house).map(t => t._id);

        const payments = await Payment.find({
            tenant: { $in: tenantIds },
            month,
            status: { $in: ['paid', 'partial'] }
        }).select('tenant amount');

        const paidMap = {};
        for (const p of payments) {
            const key = String(p.tenant);
            paidMap[key] = (paidMap[key] || 0) + p.amount;
        }

        const result = [];
        for (const tenant of tenants) {
            if (!tenant.house) continue;
            const rent      = tenant.house.rent;
            const totalPaid = paidMap[String(tenant._id)] || 0;
            const balance   = Math.max(0, rent - totalPaid);
            if (balance > 0) {
                result.push({
                    tenantId:  tenant._id,
                    tenant:    tenant.name,
                    email:     tenant.email,
                    house:     tenant.house.name,
                    month,
                    rent,
                    totalPaid,
                    balance,
                    status:    totalPaid > 0 ? 'partial' : 'unpaid'
                });
            }
        }

        res.json(result);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// ═══════════════════════════════════════
// EXPENSES
// ═══════════════════════════════════════

app.post('/expenses', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || null;
        const category    = req.body.category || 'other';
        const amount      = Number(req.body.amount);
        const month       = sanitize(req.body.month || '');
        const note        = sanitize(req.body.note || '', 300);

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });
        if (!amount || amount <= 0) return res.status(400).json({ message: 'A valid amount is required' });
        if (!month) return res.status(400).json({ message: 'month is required' });

        const validCategories = ['water', 'electricity', 'repairs', 'security', 'cleaning', 'staff', 'other'];
        if (!validCategories.includes(category)) {
            return res.status(400).json({ message: `category must be one of: ${validCategories.join(', ')}` });
        }

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const expense = await Expense.create({
            landlord: req.user.id,
            property: propertyId,
            category,
            amount,
            month,
            note,
            datePaid: new Date()
        });

        logActivity({
            landlord: req.user.id, property: propertyId,
            action:   'expense.recorded',
            message:  `Ksh ${Number(amount).toLocaleString()} expense (${category}) recorded for ${property.name} — ${month}`,
            meta:     { expenseId: expense._id, amount, category, month }
        });

        res.status(201).json({ message: 'Expense recorded ✅', expense });

    } catch (err) {
        console.error('Create expense error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

app.get('/expenses', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const query = { landlord: req.user.id };

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        }
        if (req.query.month) query.month = req.query.month;

        const expenses = await Expense.find(query)
            .populate('property', 'name')
            .sort({ createdAt: -1 })
            .limit(200);

        res.json(expenses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/expenses/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const expense = await Expense.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!expense) return res.status(404).json({ message: 'Expense not found' });

        await expense.deleteOne();

        logActivity({
            landlord: req.user.id, property: expense.property,
            action:   'expense.deleted',
            message:  `Ksh ${Number(expense.amount).toLocaleString()} expense (${expense.category}) for ${expense.month} was deleted`,
            meta:     { expenseId: expense._id }
        });

        res.json({ message: 'Expense deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting expense ❌' });
    }
});


// ═══════════════════════════════════════
// MAINTENANCE REQUESTS
// ═══════════════════════════════════════

app.post('/maintenance-requests', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant') {
            return res.status(403).json({ message: 'Tenants only. Landlords manage requests via PUT /maintenance-requests/:id/status.' });
        }
        if (!req.user.tenantId) {
            return res.status(400).json({ message: 'No tenant linked to this account' });
        }

        const category    = req.body.category || 'other';
        const description = sanitize(req.body.description || '', 1000);
        const priority     = req.body.priority || 'medium';

        if (!description) return res.status(400).json({ message: 'Description is required' });

        const validCategories = ['plumbing', 'electrical', 'structural', 'appliance', 'pest', 'other'];
        if (!validCategories.includes(category)) {
            return res.status(400).json({ message: `category must be one of: ${validCategories.join(', ')}` });
        }
        const validPriorities = ['low', 'medium', 'high'];
        if (!validPriorities.includes(priority)) {
            return res.status(400).json({ message: `priority must be one of: ${validPriorities.join(', ')}` });
        }

        const tenant = await Tenant.findById(req.user.tenantId).select('property landlord house name');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const request = await MaintenanceRequest.create({
            landlord:    tenant.landlord,
            property:    tenant.property,
            tenant:      tenant._id,
            house:       tenant.house || null,
            category,
            description,
            priority
        });

        logActivity({
            landlord: tenant.landlord, property: tenant.property,
            action:   'maintenance.reported',
            message:  `${tenant.name} reported a ${category} issue`,
            meta:     { requestId: request._id, category, priority }
        });

        res.status(201).json({ message: 'Maintenance request submitted ✅', request });

    } catch (err) {
        console.error('Create maintenance request error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

app.get('/maintenance-requests', authMiddleware, async (req, res) => {
    try {
        let query;

        if (req.user.role === 'landlord') {
            query = { landlord: req.user.id };

            if (req.query.propertyId) {
                const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
                if (!property) return res.status(404).json({ message: 'Property not found' });
                query.property = req.query.propertyId;
            }
            if (req.query.status) query.status = req.query.status;

        } else {
            if (!req.user.tenantId) return res.json([]);
            query = { tenant: req.user.tenantId };
        }

        const requests = await MaintenanceRequest.find(query)
            .populate('tenant', 'name phone')
            .populate('house', 'name')
            .populate('property', 'name')
            .sort({ createdAt: -1 })
            .limit(200);

        res.json(requests);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/maintenance-requests/:id/status', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const { status, cost, resolutionNote } = req.body;
        const allowed = ['reported', 'in_progress', 'completed'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ message: `Status must be one of: ${allowed.join(', ')}` });
        }

        const request = await MaintenanceRequest.findOne({ _id: req.params.id, landlord: req.user.id })
            .populate('tenant', 'name');
        if (!request) return res.status(404).json({ message: 'Maintenance request not found' });

        request.status = status;
        if (cost !== undefined && cost !== null && cost !== '') request.cost = Number(cost);
        if (typeof resolutionNote === 'string') request.resolutionNote = sanitize(resolutionNote, 500);
        if (status === 'completed' && !request.completedAt) request.completedAt = new Date();
        if (status !== 'completed') request.completedAt = null;

        await request.save();

        logActivity({
            landlord: req.user.id, property: request.property,
            action:   'maintenance.status_changed',
            message:  `${request.tenant?.name || 'Tenant'}'s ${request.category} request marked ${status}`,
            meta:     { requestId: request._id, status }
        });

        res.json({ message: 'Request updated ✅', request });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.delete('/maintenance-requests/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const request = await MaintenanceRequest.findOneAndDelete({ _id: req.params.id, landlord: req.user.id });
        if (!request) return res.status(404).json({ message: 'Maintenance request not found' });
        res.json({ message: 'Maintenance request deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting request ❌' });
    }
});

// ═══════════════════════════════════════
// ACTIVITY LOG
// ═══════════════════════════════════════

app.get('/activity', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const query = { landlord: req.user.id };

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        }
        if (req.query.action) query.action = req.query.action;

        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 30);
        const skip  = (page - 1) * limit;

        const [logs, total] = await Promise.all([
            AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            AuditLog.countDocuments(query)
        ]);

        res.json({ logs, total, page, pages: Math.ceil(total / limit) });

    } catch (err) {
        console.error('GET /activity error:', err.message);
        res.status(500).json({ error: err.message });
    }
});



// ═══════════════════════════════════════
// BULK ACTIONS
// ═══════════════════════════════════════

app.post('/tenants/bulk-remind', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const tenantIds = Array.isArray(req.body.tenantIds) ? req.body.tenantIds : [];
        if (!tenantIds.length) return res.status(400).json({ message: 'tenantIds array is required' });

        const tenants = await Tenant.find({
            _id:      { $in: tenantIds },
            landlord: req.user.id,
            status:   'active'
        }).populate('house');

        if (!tenants.length) return res.status(404).json({ message: 'No matching active tenants found' });

        const month = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
        let sent = 0, skipped = 0;

        for (const tenant of tenants) {
            if (!tenant.house) { skipped++; continue; }

            const summary = await getMonthSummary(tenant._id, month, tenant.house.rent);
            if (summary.balance <= 0) { skipped++; continue; }

            sendRentReminder({
                name:    tenant.name,
                email:   tenant.email,
                house:   tenant.house.name,
                rent:    tenant.house.rent,
                month,
                dueDate: tenant.dueDate,
                arrears: summary.balance
            }).catch(err => console.error(`Bulk reminder failed for ${tenant.name}:`, err.message));

            sent++;
        }

        logActivity({
            landlord: req.user.id,
            action:   'tenants.bulk_reminded',
            message:  `Sent ${sent} rent reminder${sent === 1 ? '' : 's'} manually`,
            meta:     { sent, skipped, tenantIds }
        });

        res.json({
            message: `Reminders sent to ${sent} tenant(s)${skipped ? `, ${skipped} skipped (no balance or no house)` : ''} ✅`,
            sent, skipped
        });

    } catch (err) {
        console.error('bulk-remind error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/arrears/export', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const month = sanitize(req.query.month || '') || new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
        const query = { landlord: req.user.id, status: 'active' };

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        }

        const tenants   = await Tenant.find(query).populate('house').populate('property', 'name');
        const tenantIds = tenants.filter(t => t.house).map(t => t._id);

        const payments = await Payment.find({
            tenant: { $in: tenantIds },
            month,
            status: { $in: ['paid', 'partial'] }
        }).select('tenant amount');

        const paidMap = {};
        for (const p of payments) {
            const key = String(p.tenant);
            paidMap[key] = (paidMap[key] || 0) + p.amount;
        }

        const rows = [['Tenant', 'Email', 'Phone', 'Property', 'House', 'Rent', 'Paid', 'Balance', 'Status', 'Month']];

        for (const tenant of tenants) {
            if (!tenant.house) continue;
            const rent      = tenant.house.rent;
            const totalPaid = paidMap[String(tenant._id)] || 0;
            const balance   = Math.max(0, rent - totalPaid);
            if (balance <= 0) continue;

            rows.push([
                tenant.name, tenant.email, tenant.phone || '',
                tenant.property?.name || '', tenant.house.name,
                rent, totalPaid, balance,
                totalPaid > 0 ? 'partial' : 'unpaid', month
            ]);
        }

        // RFC 4180-safe CSV escaping
        const csv = rows.map(row =>
            row.map(cell => {
                const str = String(cell ?? '');
                return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
            }).join(',')
        ).join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="arrears-${month.replace(/\s+/g, '-')}.csv"`);
        res.send(csv);

    } catch (err) {
        console.error('arrears export error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// M-PESA STK PUSH (RENT)
// ═══════════════════════════════════════

app.post('/stkpush', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant') {
            return res.status(403).json({ message: 'Tenants only.' });
        }

        const amount = Number(req.body.amount);
        const month  = sanitize(req.body.month || '');

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

        const property = await Property.findById(tenant.property);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (!property.paymentConfigured || !property.mpesaConsumerKey) {
            return res.status(400).json({
                message: 'Your landlord has not configured M-Pesa payments for this property yet.',
                code:    'PAYMENT_NOT_CONFIGURED'
            });
        }

        const rent    = tenant.house.rent;
        const summary = await getMonthSummary(tenantId, month, rent);

        if (summary.status === 'paid') {
            return res.status(400).json({ message: `Rent for ${month} is already fully paid ✅`, summary });
        }
        if (amount > summary.balance) {
            return res.status(400).json({
                message: `Amount exceeds balance. Remaining balance is Ksh ${summary.balance}.`,
                balance: summary.balance,
                summary
            });
        }

        const token          = await getRentToken(property);
        const passkey        = decrypt(property.mpesaPasskey);
        const shortcode      = property.paybillNumber;
        const timestamp      = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password       = Buffer.from(shortcode + passkey + timestamp).toString('base64');

        // FIX: normalize phone (07... / +254... → 254...) — Safaricom rejects/mishandles
        // anything that isn't 254XXXXXXXXX, and tenant.phone is stored however it was typed.
        const normalizedPhone = normalizePhone(tenant.phone);

        // FIX: Safaricom requires a whole-number amount — round up so a fractional
        // balance (e.g. 2500.50) never gets sent raw.
        const stkAmount = Math.ceil(amount);

        const stkRes = await axios.post(
            `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
            {
                BusinessShortCode: shortcode,
                Password:          password,
                Timestamp:         timestamp,
                TransactionType:   'CustomerPayBillOnline',
                Amount:            stkAmount,
                PartyA:            normalizedPhone,
                PartyB:            shortcode,
                PhoneNumber:       normalizedPhone,
                CallBackURL:       process.env.MPESA_CALLBACK_URL,
                AccountReference:  `Rent-${month}`,
                TransactionDesc:   `Rent payment for ${month}`
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = stkRes.data;

        if (data.ResponseCode !== '0') {
            return res.status(400).json({ message: data.ResponseDescription || 'STK push failed', data });
        }

        const newTotalPaid = summary.totalPaid + amount;
        const newBalance   = Math.max(0, rent - newTotalPaid);

        await Payment.create({
            landlord:          tenant.landlord,
            property:          tenant.property,
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
        res.status(500).json({ error: 'STK Push failed', details: err.response?.data || err.message });
    }
});

// FIX Bug 14: callback now requires the secret path segment to match
// MPESA_CALLBACK_SECRET. Set MPESA_CALLBACK_URL to include it, e.g.:
//   https://<your-render-service>.onrender.com/callback/<MPESA_CALLBACK_SECRET>
// A legacy /callback (no secret) route is kept below purely to 404 cleanly
// if something still points at the old URL, rather than 404'ing at the Express level.
app.post('/callback/:secret', async (req, res) => {
    if (!validateCallbackSecret(req, res)) return; // response already sent inside

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

            const rent        = payment.house?.rent || payment.rentAmount;
            const previousAgg = await Payment.aggregate([
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
            sendMpesaConfirmationEmail({
                tenant:       payment.tenant,
                house:        payment.house,
                payment,
                mpesaCode,
                newTotalPaid,
                newBalance,
                newStatus
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

// Legacy path with no secret — reject cleanly rather than 404 at the framework level.
// Safe to remove once you've confirmed MPESA_CALLBACK_URL is updated everywhere.
app.post('/callback', (req, res) => res.status(404).end());

app.get('/payment-status/:checkoutRequestId', authMiddleware, async (req, res) => {
    try {
        const payment = await Payment.findOne({ checkoutRequestId: req.params.checkoutRequestId });
        if (!payment) return res.status(404).json({ status: 'not_found' });

        let clientStatus = payment.status;
        if (payment.status === 'paid' || payment.status === 'partial') clientStatus = 'confirmed';

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

app.post('/stk-query', authMiddleware, async (req, res) => {
    try {
        const { checkoutRequestId } = req.body;
        if (!checkoutRequestId) return res.status(400).json({ message: 'checkoutRequestId required' });

        const payment = await Payment.findOne({ checkoutRequestId }).populate('tenant');
        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        const property = await Property.findById(payment.property);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const token     = await getRentToken(property);
        const passkey   = decrypt(property.mpesaPasskey);
        const shortcode = property.paybillNumber;
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password  = Buffer.from(shortcode + passkey + timestamp).toString('base64');

        const response = await axios.post(
            `${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`,
            {
                BusinessShortCode: shortcode,
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
        res.status(500).json({ error: 'STK query failed', details: err.response?.data || err.message });
    }
});


// ═══════════════════════════════════════
// RECEIPTS
// ═══════════════════════════════════════

app.get('/receipt/:paymentId', authMiddleware, async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        if (req.user.role === 'tenant' && String(payment.tenant?._id) !== String(req.user.tenantId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }
        if (req.user.role === 'landlord' && String(payment.landlord) !== String(req.user.id)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        res.json(payment);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/receipt/pdf/:paymentId', authMiddleware, async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId)
            .populate('tenant')
            .populate('house');

        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        if (req.user.role === 'tenant' && String(payment.tenant?._id) !== String(req.user.tenantId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }
        if (req.user.role === 'landlord' && String(payment.landlord) !== String(req.user.id)) {
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

// FIX Bug 15: batch payment aggregation instead of N+1 getMonthSummary calls
app.get('/dashboard/:month', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const month         = req.params.month;
        const tenantQuery   = { landlord: req.user.id, status: 'active' };
        const houseQuery    = { landlord: req.user.id };
        const expenseQuery  = { landlord: new mongoose.Types.ObjectId(req.user.id), month };
        const maintQuery    = { landlord: req.user.id, status: { $in: ['reported', 'in_progress'] } };
        let   propertyInfo  = null;

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            tenantQuery.property  = req.query.propertyId;
            houseQuery.property   = req.query.propertyId;
            expenseQuery.property = new mongoose.Types.ObjectId(req.query.propertyId);
            maintQuery.property   = req.query.propertyId;
            propertyInfo = { id: property._id, name: property.name, location: property.location };
        }

        const tenants = await Tenant.find(tenantQuery).populate('house');
        const houses  = await House.find(houseQuery);

        let occupied = 0;
        houses.forEach(h => { if (h.status === 'occupied') occupied++; });

        // Batch payment fetch
        const tenantIds     = tenants.filter(t => t.house).map(t => t._id);
        const paymentsAgg   = await Payment.aggregate([
            {
                $match: {
                    tenant: { $in: tenantIds },
                    month,
                    status: { $in: ['paid', 'partial'] }
                }
            },
            {
                $group: { _id: '$tenant', totalPaid: { $sum: '$amount' } }
            }
        ]);

        const paidMap = {};
        for (const p of paymentsAgg) {
            paidMap[String(p._id)] = p.totalPaid;
        }

        let totalIncome = 0, totalArrears = 0;
        for (const tenant of tenants) {
            if (!tenant.house) continue;
            const rent      = tenant.house.rent;
            const totalPaid = paidMap[String(tenant._id)] || 0;
            totalIncome  += totalPaid;
            totalArrears += Math.max(0, rent - totalPaid);
        }

        // ── Expenses for this property/month → Net Income = Collected − Expenses ──
        const expensesAgg = await Expense.aggregate([
            { $match: expenseQuery },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalExpenses = expensesAgg[0]?.total || 0;

        // ── Open maintenance requests (not scoped to month — a request stays
        //    "open" across month boundaries until resolved) ──
        const openMaintenanceCount = await MaintenanceRequest.countDocuments(maintQuery);

        const landlord = await User.findById(req.user.id)
            .select('name propertyName propertyLocation paymentConfigured accountStatus');

        res.json({
            month,
            totalIncome,
            totalArrears,
            totalExpenses,
            netIncome:            totalIncome - totalExpenses,
            openMaintenanceCount,
            totalTenants:         tenants.length,
            totalHouses:          houses.length,
            occupiedHouses:       occupied,
            vacantHouses:         houses.length - occupied,
            paymentConfigured:    landlord.paymentConfigured,
            property:             propertyInfo,
            landlordProfile: {
                name:             landlord.name,
                propertyName:     landlord.propertyName,
                propertyLocation: landlord.propertyLocation
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// COMMISSION SYSTEM
// ═══════════════════════════════════════
//
// FIX (plans → commission migration): replaces the old SUBSCRIPTION SYSTEM
// section entirely. The platform is free forever — instead, each property
// owes a percentage (set by the stacklord) of whatever rent it actually
// collected in a given month. See computeCommissionForProperty() above for
// the shared calculation logic both routes below rely on.

// ── Landlord: current global rate + whether they've seen the latest change ──
app.get('/commission-rate', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const settings = await getPlatformSettings();
        const user     = await User.findById(req.user.id).select('lastSeenCommissionUpdatedAt');

        const hasUnseenUpdate = !user.lastSeenCommissionUpdatedAt
            || new Date(user.lastSeenCommissionUpdatedAt) < new Date(settings.updatedAt);

        // ── Only the most recently CLOSED month can ever be "due" —
        //    the current, still-running month is never included here. ──
        const dueMonth = getMonthLabel(-1);
        const properties = await Property.find({ landlord: req.user.id }).select('_id');

        let totalDue = 0;
        for (const prop of properties) {
            const { amountDue } = await computeCommissionForProperty(prop._id, dueMonth);
            if (amountDue <= 0) continue;
            const paid = await CommissionPayment.findOne({ property: prop._id, month: dueMonth, status: 'paid' });
            if (!paid) totalDue += amountDue;
        }

        res.json({
            commissionPercentage: settings.commissionPercentage,
            updatedAt:             settings.updatedAt,
            dueMonth,
            totalDue,
            notice: hasUnseenUpdate
                ? { message: `📢 Platform commission rate is now ${settings.commissionPercentage}%, effective ${new Date(settings.updatedAt).toDateString()}.` }
                : (totalDue > 0
                    ? { message: `⚠️ Ksh ${totalDue.toLocaleString()} commission is due for ${dueMonth}.` }
                    : null)
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── Landlord: dismiss the "rate changed" banner ──
app.put('/landlord/commission-notice/ack', authMiddleware, landlordOnly, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user.id, { lastSeenCommissionUpdatedAt: new Date() });
        res.json({ message: 'Acknowledged ✅' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Landlord: how much is owed for one property/month ──
app.get('/commission/summary/:propertyId/:month', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const property = await Property.findOne({ _id: req.params.propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const { totalCollected, percentage, amountDue } = await computeCommissionForProperty(property._id, req.params.month);

        const alreadyPaid = await CommissionPayment.findOne({
            property: property._id,
            month:    req.params.month,
            status:   'paid'
        });

        res.json({
            month:          req.params.month,
            totalCollected,
            percentage,
            amountDue,
            alreadyPaid: !!alreadyPaid,
            paidAt:      alreadyPaid?.paidAt || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Landlord: pay the commission owed for one property/month via STK push ──
app.post('/commission/pay', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || '';
        const month       = sanitize(req.body.month || '');
        const phone        = sanitize(req.body.phone || '');

        if (!propertyId || !month || !phone) {
            return res.status(400).json({ message: 'propertyId, month and phone are required' });
        }

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const alreadyPaid = await CommissionPayment.findOne({ property: property._id, month, status: 'paid' });
        if (alreadyPaid) {
            return res.status(400).json({ message: `Commission for ${month} on ${property.name} is already paid ✅` });
        }

        // Always recompute server-side — never trust a client-supplied amount.
        const { totalCollected, percentage, amountDue } = await computeCommissionForProperty(property._id, month);

        if (amountDue <= 0) {
            return res.status(400).json({ message: `Nothing owed for ${month} — no commission due.` });
        }

        if (!process.env.SYSTEM_PAYBILL) {
            console.error('FATAL: SYSTEM_PAYBILL is not set');
            return res.status(500).json({ message: 'Server configuration error' });
        }

        const token     = await getSystemToken();
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password  = Buffer.from(
            process.env.SYSTEM_PAYBILL + process.env.SYSTEM_PASSKEY + timestamp
        ).toString('base64');

        const normalizedPhone = normalizePhone(phone);

        const stkRes = await axios.post(
            `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
            {
                BusinessShortCode: process.env.SYSTEM_PAYBILL,
                Password:          password,
                Timestamp:         timestamp,
                TransactionType:   'CustomerPayBillOnline',
                Amount:            amountDue,
                PartyA:            normalizedPhone,
                PartyB:            process.env.SYSTEM_PAYBILL,
                PhoneNumber:       normalizedPhone,
                CallBackURL:       `${process.env.BASE_URL}/commission-callback/${process.env.MPESA_CALLBACK_SECRET}`,
                AccountReference:  `Commission-${month}`,
                TransactionDesc:   `Platform commission — ${property.name} — ${month}`
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = stkRes.data;

        if (data.ResponseCode !== '0') {
            return res.status(400).json({ message: data.ResponseDescription || 'STK push failed', data });
        }

        await CommissionPayment.create({
            landlord:          req.user.id,
            property:          property._id,
            month,
            totalCollected,
            percentage,
            amountDue,
            status:            'pending',
            phone,
            checkoutRequestId: data.CheckoutRequestID,
            merchantRequestId: data.MerchantRequestID
        });

        res.json({
            message:           `M-Pesa prompt sent to ${phone} 📱`,
            checkoutRequestId: data.CheckoutRequestID,
            amountDue, totalCollected, percentage
        });

    } catch (err) {
        console.error('🔥 Commission pay STK error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Commission payment failed', details: err.response?.data || err.message });
    }
});

// FIX Bug 14 pattern reused: secret-path callback, same guarantee as /callback/:secret.
app.post('/commission-callback/:secret', async (req, res) => {
    if (!validateCallbackSecret(req, res)) return;

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    try {
        const stk = req.body?.Body?.stkCallback;
        if (!stk) return;

        const checkoutRequestId = stk.CheckoutRequestID;
        const resultCode        = stk.ResultCode;

        const commissionPayment = await CommissionPayment.findOne({ checkoutRequestId })
            .populate('property')
            .populate('landlord');

        if (!commissionPayment) {
            console.log('Commission callback: no pending payment for', checkoutRequestId);
            return;
        }

        if (resultCode === 0) {
            const items     = stk.CallbackMetadata?.Item || [];
            const getItem   = name => items.find(i => i.Name === name)?.Value;
            const mpesaCode = getItem('MpesaReceiptNumber') || '';

            commissionPayment.status    = 'paid';
            commissionPayment.mpesaCode = mpesaCode;
            commissionPayment.paidAt    = new Date();
            await commissionPayment.save();
            await maybeAutoUnsuspendProperty(commissionPayment.property._id);

            console.log(`✅ Commission confirmed: ${mpesaCode} | ${commissionPayment.property?.name} | ${commissionPayment.month}`);

        } else {
            commissionPayment.status = 'failed';
            await commissionPayment.save();
            console.log(`❌ Commission payment failed — ResultCode: ${resultCode}`);
        }

        logActivity({
                landlord: commissionPayment.landlord._id,
                property: commissionPayment.property._id,
                action:   'commission.paid',
                message:  `Commission of Ksh ${Number(commissionPayment.amountDue).toLocaleString()} paid for ${commissionPayment.property.name} (${commissionPayment.month})`,
                meta:     { commissionPaymentId: commissionPayment._id, mpesaCode }
            });

    } catch (err) {
        console.error('Commission callback error:', err.message);
    }
});

// Legacy path with no secret — reject cleanly.
app.post('/commission-callback', (req, res) => res.status(404).end());


// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════

app.post('/rules', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || null;
        const title      = sanitize(req.body.title   || '', 200);
        const content    = sanitize(req.body.content || '', 1000);

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const rule = await Rule.create({ title, content, landlord: req.user.id, property: propertyId });
        res.json(rule);
    } catch (err) {
        res.status(500).json({ message: 'Error adding rule' });
    }
});

app.get('/rules', authMiddleware, async (req, res) => {
    try {
        let query;

        if (req.user.role === 'landlord') {
            if (!req.query.propertyId) return res.status(400).json({ message: 'propertyId is required' });
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query = { property: req.query.propertyId };
        } else {
            const tenant = await Tenant.findById(req.user.tenantId).select('property');
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            query = { property: tenant.property };
        }

        const rules = await Rule.find(query).sort({ createdAt: 1 });
        res.json(rules);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching rules' });
    }
});

app.delete('/rules/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const rule = await Rule.findOneAndDelete({ _id: req.params.id, landlord: req.user.id });
        if (!rule) return res.status(404).json({ message: 'Rule not found' });
        res.json({ message: 'Rule deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting rule' });
    }
});


// ═══════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════

app.post('/announcements', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || null;
        const message    = sanitize(req.body.message || '', 1000);

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });
        if (!message)    return res.status(400).json({ message: 'Message is required' });

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const a = await Announcement.create({ message, landlord: req.user.id, property: propertyId });
        res.json(a);
    } catch (err) {
        res.status(500).json({ message: 'Error creating announcement' });
    }
});

app.get('/announcements', authMiddleware, async (req, res) => {
    try {
        let query;

        if (req.user.role === 'landlord') {
            if (!req.query.propertyId) return res.status(400).json({ message: 'propertyId is required' });
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query = { property: req.query.propertyId };
        } else {
            const tenant = await Tenant.findById(req.user.tenantId).select('property');
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            query = { property: tenant.property };
        }

        const list = await Announcement.find(query).sort({ createdAt: -1 }).limit(50);
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching announcements' });
    }
});

app.delete('/announcements/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const a = await Announcement.findOneAndDelete({ _id: req.params.id, landlord: req.user.id });
        if (!a) return res.status(404).json({ message: 'Announcement not found' });
        res.json({ message: 'Announcement deleted ✅' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting announcement' });
    }
});


// ═══════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════

app.post('/messages', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant') {
            return res.status(403).json({ message: 'Tenants only. Landlords use POST /messages/reply.' });
        }
        if (!req.user.tenantId) {
            return res.status(400).json({ message: 'No tenant linked to this account' });
        }

        const text = sanitize(req.body.text || '', 2000);
        if (!text) return res.status(400).json({ message: 'Message text is required' });

        const tenant = await Tenant.findById(req.user.tenantId).select('property landlord');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const msg = await Message.create({
            landlord: tenant.landlord,
            property: tenant.property,
            tenant:   req.user.tenantId,
            sender:   'tenant',
            text,
            isRead:   false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: 'Error sending message' });
    }
});

app.post('/messages/reply', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenantId = req.body.tenantId || '';
        const text     = sanitize(req.body.text || '', 2000);

        if (!tenantId || !text) {
            return res.status(400).json({ message: 'tenantId and text are required' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id });
        if (!tenant) return res.status(403).json({ message: 'Forbidden' });

        const msg = await Message.create({
            landlord: req.user.id,
            property: tenant.property,
            tenant:   tenantId,
            sender:   'landlord',
            text,
            isRead:   false
        });

        res.json(msg);

    } catch (err) {
        res.status(500).json({ message: 'Error sending reply' });
    }
});

// FIX Bug 17: paginate message thread
app.get('/messages/my', authMiddleware, async (req, res) => {
    try {
        if (!req.user.tenantId) {
            return res.status(400).json({ message: 'No tenant linked to this account' });
        }

        const tenant = await Tenant.findById(req.user.tenantId).select('property');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const page  = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const skip  = (page - 1) * limit;

        const messages = await Message.find({
            property: tenant.property,
            tenant:   req.user.tenantId
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .then(msgs => msgs.reverse()); // return chronological order

        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching messages' });
    }
});

// FIX Bug 17: paginate landlord chat thread
app.get('/messages/thread/:tenantId', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: req.user.id });
        if (!tenant) return res.status(403).json({ message: 'Forbidden' });

        const page  = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const skip  = (page - 1) * limit;

        const messages = await Message.find({
            property: tenant.property,
            tenant:   req.params.tenantId
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .then(msgs => msgs.reverse());

        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching thread' });
    }
});

app.put('/messages/read/:tenantId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'tenant') {
            if (String(req.user.tenantId) !== req.params.tenantId) {
                return res.status(403).json({ message: 'Forbidden' });
            }

            const tenant = await Tenant.findById(req.user.tenantId).select('property');
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            await Message.updateMany(
                { property: tenant.property, tenant: req.params.tenantId, sender: 'landlord', isRead: false },
                { isRead: true }
            );
        } else {
            const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: req.user.id });
            if (!tenant) return res.status(403).json({ message: 'Forbidden' });

            await Message.updateMany(
                { property: tenant.property, tenant: req.params.tenantId, sender: 'tenant', isRead: false },
                { isRead: true }
            );
        }

        res.json({ message: 'Marked as read' });

    } catch (err) {
        res.status(500).json({ message: 'Error marking as read' });
    }
});

app.get('/messages/unread', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const matchQuery = {
            landlord: new mongoose.Types.ObjectId(req.user.id),
            sender:   'tenant',
            isRead:   false
        };

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            matchQuery.property = new mongoose.Types.ObjectId(req.query.propertyId);
        }

        const unread = await Message.aggregate([
            { $match: matchQuery },
            { $group: { _id: '$tenant', count: { $sum: 1 } } }
        ]);

        res.json(unread);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching unread messages' });
    }
});

app.get('/messages/unread-mine', authMiddleware, async (req, res) => {
    try {
        if (!req.user.tenantId) return res.json({ count: 0 });

        const tenant = await Tenant.findById(req.user.tenantId).select('property');
        if (!tenant) return res.json({ count: 0 });

        const count = await Message.countDocuments({
            property: tenant.property,
            tenant:   req.user.tenantId,
            sender:   'landlord',
            isRead:   false
        });

        res.json({ count });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching unread count' });
    }
});


// ═══════════════════════════════════════
// STACKLORD ROUTES
// ═══════════════════════════════════════

app.get('/stacklord/stats', stacklordAuth, async (req, res) => {
    try {
        const totalLandlords  = await User.countDocuments({ role: 'landlord' });
        const totalTenants    = await User.countDocuments({ role: 'tenant' });
        const totalHouses     = await House.countDocuments();
        const totalProperties = await Property.countDocuments();
        const totalCommissionPayments = await CommissionPayment.countDocuments({ status: 'paid' });

        const revenueResult = await CommissionPayment.aggregate([
            { $match: { status: 'paid' } },
            { $group: { _id: null, total: { $sum: '$amountDue' } } }
        ]);
        const totalRevenue = revenueResult[0]?.total || 0;

        const byStatus = await User.aggregate([
            { $match: { role: 'landlord' } },
            { $group: { _id: '$accountStatus', count: { $sum: 1 } } }
        ]);

        const settings = await getPlatformSettings();

        res.json({
            stats: {
                totalLandlords,
                totalTenants,
                totalHouses,
                totalProperties,
                totalRevenue,
                totalCommissionPayments,
                byStatus,
                commissionPercentage: settings.commissionPercentage
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/stacklord/landlords', stacklordAuth, async (req, res) => {
    try {
        const landlords = await User.find({ role: 'landlord' })
            .select('-password -mpesaConsumerKey -mpesaConsumerSecret -mpesaPasskey')
            .sort({ createdAt: -1 });

        const enriched = await Promise.all(landlords.map(async l => {
            const tenantCount = await Tenant.countDocuments({ landlord: l._id });
            const houseCount  = await House.countDocuments({ landlord: l._id });
            const properties  = await Property.find({ landlord: l._id })
                .select('name location paymentConfigured isListed isApproved geo formattedAddress')
                .lean();

            return {
                ...l.toJSON(),
                tenantCount,
                houseCount,
                propertyCount: properties.length,
                properties: properties.map(p => ({
                    _id:               p._id,
                    name:              p.name,
                    location:          p.location,
                    paymentConfigured: p.paymentConfigured,
                    isListed:          p.isListed,
                    isApproved:        p.isApproved,
                    hasLocation:       !!(p.geo && Array.isArray(p.geo.coordinates))
                }))
            };
        }));

        res.json(enriched);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── Stacklord: set the global commission percentage ──
app.post('/stacklord/commission-rate', stacklordAuth, async (req, res) => {
    try {
        const percentage = Number(req.body.percentage);
        if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
            return res.status(400).json({ message: 'percentage must be a number between 0 and 100' });
        }

        let settings = await PlatformSettings.findOne();
        if (!settings) {
            settings = await PlatformSettings.create({
                commissionPercentage: percentage,
                updatedAt:             new Date(),
                updatedBy:             'stacklord'
            });
        } else {
            settings.commissionPercentage = percentage;
            settings.updatedAt            = new Date();
            settings.updatedBy            = 'stacklord';
            await settings.save();
        }

        await CommissionRateHistory.create({ percentage, changedBy: 'stacklord' });

        res.json({ message: `Commission rate set to ${percentage}% ✅`, settings });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/stacklord/commission-rate', stacklordAuth, async (req, res) => {
    try {
        const settings = await getPlatformSettings();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: commission rate change log ──
app.get('/stacklord/commission-rate-history', stacklordAuth, async (req, res) => {
    try {
        const history = await CommissionRateHistory.find().sort({ changedAt: -1 }).limit(50).lean();
        res.json({ history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: toggle auto-approval of new public listings ──
app.put('/stacklord/auto-approve-listings', stacklordAuth, async (req, res) => {
    try {
        const enabled = Boolean(req.body.enabled);

        let settings = await PlatformSettings.findOne();
        if (!settings) settings = await PlatformSettings.create({ commissionPercentage: 0 });

        settings.autoApproveListings = enabled;
        await settings.save();

        res.json({
            message: `Auto-approve listings ${enabled ? 'enabled ✅ — new listings go live instantly' : 'disabled — new listings require manual review'}`,
            autoApproveListings: settings.autoApproveListings
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: toggle platform-wide maintenance (kill switch) ──
app.put('/stacklord/platform-maintenance', stacklordAuth, async (req, res) => {
    try {
        const enabled = Boolean(req.body.enabled);
        const message = sanitize(req.body.message || '', 500);

        let settings = await PlatformSettings.findOne();
        if (!settings) settings = await PlatformSettings.create({ commissionPercentage: 0 });

        settings.platformMaintenanceMode    = enabled;
        settings.platformMaintenanceMessage = message || (enabled
            ? 'Affordable Rentals is temporarily down for maintenance. Please check back shortly.'
            : '');
        await settings.save();

        res.json({
            message: `Platform maintenance ${enabled ? 'enabled 🔧' : 'disabled ✅'}`,
            platformMaintenanceMode:    settings.platformMaintenanceMode,
            platformMaintenanceMessage: settings.platformMaintenanceMessage
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: total commission currently owed, grouped by landlord ──
app.get('/stacklord/commission/outstanding', stacklordAuth, async (req, res) => {
    try {
        // "Outstanding" implies a closed month — default to the previous
        // one, not whatever's still in progress right now.
        const month = req.query.month || getMonthLabel(-1);

        const properties     = await Property.find({}).select('name landlord').lean();
        const owedByLandlord = {};

        for (const prop of properties) {
            const { amountDue } = await computeCommissionForProperty(prop._id, month);
            if (amountDue <= 0) continue;

            const alreadyPaid = await CommissionPayment.findOne({ property: prop._id, month, status: 'paid' });
            if (alreadyPaid) continue;

            const key = String(prop.landlord);
            if (!owedByLandlord[key]) owedByLandlord[key] = { totalOwed: 0, properties: [] };
            owedByLandlord[key].totalOwed += amountDue;
            owedByLandlord[key].properties.push({ propertyId: prop._id, name: prop.name, amountDue, month });
        }

        const landlordIds = Object.keys(owedByLandlord);
        const landlords    = await User.find({ _id: { $in: landlordIds } }).select('name email');
        const landlordMap  = {};
        landlords.forEach(l => { landlordMap[String(l._id)] = l; });

        const result = landlordIds.map(id => ({
            landlordId:    id,
            landlordName:  landlordMap[id]?.name  || '—',
            landlordEmail: landlordMap[id]?.email || '—',
            totalOwed:     owedByLandlord[id].totalOwed,
            properties:    owedByLandlord[id].properties
        })).sort((a, b) => b.totalOwed - a.totalOwed);

        res.json({ month, outstanding: result });

    } catch (err) {
        console.error('GET /stacklord/commission/outstanding error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: manually mark a property's commission for a month as paid
//    (e.g. landlord paid via bank transfer / cash outside M-Pesa) ──
app.post('/stacklord/commissions/mark-paid', stacklordAuth, async (req, res) => {
    try {
        const propertyId = req.body.propertyId || '';
        const month       = sanitize(req.body.month || '');
        const note        = sanitize(req.body.note  || '', 300);

        if (!propertyId || !month) {
            return res.status(400).json({ message: 'propertyId and month are required' });
        }

        const property = await Property.findById(propertyId);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const existing = await CommissionPayment.findOne({ property: propertyId, month, status: 'paid' });
        if (existing) return res.status(400).json({ message: `Commission for ${month} is already marked paid` });

        const { totalCollected, percentage, amountDue } = await computeCommissionForProperty(propertyId, month);
        if (amountDue <= 0) {
            return res.status(400).json({ message: `Nothing owed for ${month} — no commission due.` });
        }

        const record = await CommissionPayment.findOneAndUpdate(
            { property: propertyId, month },
            {
                landlord: property.landlord,
                property: propertyId,
                month,
                totalCollected,
                percentage,
                amountDue,
                status:    'paid',
                mpesaCode: 'MANUAL',
                paidAt:    new Date(),
                note
            },
            { upsert: true, returnDocument: 'after' }
        );
        await maybeAutoUnsuspendProperty(propertyId);

        res.json({ message: 'Commission marked as paid ✅', record });

    } catch (err) {
        console.error('POST /stacklord/commissions/mark-paid error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: per-property commission summary (admin view of any property) ──
app.get('/stacklord/commission/summary/:propertyId/:month', stacklordAuth, async (req, res) => {
    try {
        const property = await Property.findById(req.params.propertyId);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const { totalCollected, percentage, amountDue } = await computeCommissionForProperty(property._id, req.params.month);
        const alreadyPaid = await CommissionPayment.findOne({ property: property._id, month: req.params.month, status: 'paid' });

        res.json({
            month: req.params.month,
            totalCollected, percentage, amountDue,
            alreadyPaid: !!alreadyPaid,
            paidAt: alreadyPaid?.paidAt || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: bulk approve/reject listings ──
app.post('/stacklord/properties/bulk-approve', stacklordAuth, async (req, res) => {
    try {
        const ids     = Array.isArray(req.body.ids) ? req.body.ids : [];
        const approve = req.body.approve !== false;

        if (!ids.length) return res.status(400).json({ message: 'ids array is required' });

        const properties = await Property.find({ _id: { $in: ids } }).populate('landlord', 'name email');
        await Property.updateMany({ _id: { $in: ids } }, { isApproved: approve });

        properties.forEach(property => {
            if (property.landlord?.email) {
                sendListingApprovalEmail({
                    landlord: property.landlord,
                    property,
                    approved: approve,
                    baseUrl:  process.env.BASE_URL
                }).catch(err => console.error('Bulk listing approval email failed:', err.message));
            }
        });

        res.json({ message: `${properties.length} listing(s) ${approve ? 'approved' : 'revoked'} ✅`, count: properties.length });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stacklord: photo moderation — remove a photo from any property ──
app.delete('/stacklord/properties/:id/photos', stacklordAuth, async (req, res) => {
    try {
        const { photoUrl } = req.body;
        if (!photoUrl) return res.status(400).json({ message: 'photoUrl is required' });

        const property = await Property.findById(req.params.id);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (!property.photos.includes(photoUrl)) {
            return res.status(404).json({ message: 'Photo not found on this property' });
        }

        const urlParts  = photoUrl.split('/');
        const uploadIdx = urlParts.indexOf('upload');
        const publicId  = urlParts.slice(uploadIdx + 2).join('/').replace(/\.[^/.]+$/, '');

        cloudinary.uploader.destroy(publicId).catch(err =>
            console.error('Cloudinary delete error:', err.message)
        );

        property.photos = property.photos.filter(p => p !== photoUrl);
        await property.save();

        res.json({ message: 'Photo removed by admin ✅', photos: property.photos });

    } catch (err) {
        console.error('DELETE /stacklord/properties/:id/photos error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Stacklord: view all commission payments (paid/pending/failed) ──
app.get('/stacklord/commissions', stacklordAuth, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 50);
        const skip  = (page - 1) * limit;

        const query = {};
        if (req.query.status) query.status = req.query.status;

        const [payments, total] = await Promise.all([
            CommissionPayment.find(query)
                .populate('landlord', 'name email')
                .populate('property', 'name location')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            CommissionPayment.countDocuments(query)
        ]);

        const totalsAgg = await CommissionPayment.aggregate([
            { $match: { status: 'paid' } },
            { $group: { _id: null, totalCollected: { $sum: '$amountDue' } } }
        ]);

        res.json({
            payments,
            total,
            page,
            pages:                     Math.ceil(total / limit),
            totalCommissionCollected: totalsAgg[0]?.totalCollected || 0
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/stacklord/suspend/:landlordId', stacklordAuth, async (req, res) => {
    try {
        const reason = sanitize(req.body.reason || '', 500);
        if (!reason) return res.status(400).json({ message: 'Suspension reason is required' });

        const landlord = await User.findOneAndUpdate(
            { _id: req.params.landlordId, role: 'landlord' },
            {
                accountStatus:   'suspended',
                suspendedReason: reason,
                suspendedAt:     new Date(),
                suspendedBy:     'stacklord'
            },
            { returnDocument: "after" }
        );

        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });
        res.json({ message: 'Landlord suspended ✅', reason, landlord: landlord.name });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/stacklord/unsuspend/:landlordId', stacklordAuth, async (req, res) => {
    try {
        const landlord = await User.findOneAndUpdate(
            { _id: req.params.landlordId, role: 'landlord' },
            {
                accountStatus:   'active',
                suspendedReason: null,
                suspendedAt:     null,
                suspendedBy:     null
            },
            { returnDocument: "after" }
        );

        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });
        res.json({ message: 'Landlord unsuspended ✅ — account restored to active' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  NOTE: the old server.js had POST /stacklord/properties/:id/approve
//  defined TWICE — a bare version here and a fuller version (with
//  email notification) further down. Express only ever runs the FIRST
//  matching handler, so the second copy was dead code. Kept the fuller
//  version below; removed this duplicate.
// ─────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════
//  STACKLORD — Public Listings Management Routes
// ═══════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────
//  GET /stacklord/listings-pending
//  All properties where isListed=true, isApproved=false
// ─────────────────────────────────────────────────────────

app.get('/stacklord/listings-pending', stacklordAuth, async (req, res) => {
    try {
        const properties = await Property.find({ isListed: true, isApproved: false })
            .populate('landlord', 'name email')
            .sort({ updatedAt: -1 })
            .lean();

        res.json({ count: properties.length, properties });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  GET /stacklord/listings-approved
//  All publicly live properties
// ─────────────────────────────────────────────────────────

app.get('/stacklord/listings-approved', stacklordAuth, async (req, res) => {
    try {
        const properties = await Property.find({ isListed: true, isApproved: true })
            .populate('landlord', 'name email')
            .sort({ updatedAt: -1 })
            .lean();

        res.json({ count: properties.length, properties });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  POST /stacklord/properties/:id/approve
//  approve: true  → property goes live
//  approve: false → revoke (sets isApproved back to false)
// ─────────────────────────────────────────────────────────

app.post('/stacklord/properties/:id/approve', stacklordAuth, async (req, res) => {
    try {
        const approve  = req.body.approve !== false; // default true

        const property = await Property.findByIdAndUpdate(
            req.params.id,
            { isApproved: approve },
            { returnDocument: 'after' }
        ).populate('landlord', 'name email').select('name isListed isApproved landlord location');

        if (!property) return res.status(404).json({ message: 'Property not found' });

        // Notify landlord
    if (property.landlord?.email) {
        sendListingApprovalEmail({
            landlord: property.landlord,
            property,
            approved: approve,
            baseUrl:  process.env.BASE_URL
        }).catch(err => console.error('Listing approval email failed:', err.message));
    }

        res.json({
            message:  approve
                ? `${property.name} approved and live ✅`
                : `${property.name} approval revoked`,
            property
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  GET /stacklord/inquiries
//  All inquiries across all landlords — for oversight
// ─────────────────────────────────────────────────────────

app.get('/stacklord/inquiries', stacklordAuth, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 50);
        const skip  = (page - 1) * limit;

        const [inquiries, total] = await Promise.all([
            Inquiry.find()
                .populate('property', 'name location')
                .populate('landlord', 'name email')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Inquiry.countDocuments()
        ]);

        res.json({ inquiries, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});




// ═══════════════════════════════════════════════════════
//  PUBLIC LISTINGS — no auth required on GET
//  Add near the top of server.js alongside other requires:
//
//  const multer     = require('multer');
//  const cloudinary = require('cloudinary').v2;
//
 cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
  });

  const _photoUpload = multer({
      storage:    multer.memoryStorage(),
      limits:     { fileSize: 5 * 1024 * 1024 },   // 5 MB max
      fileFilter: (req, file, cb) => {
          if (!file.mimetype.startsWith('image/')) {
              return cb(new Error('Only image files are allowed'));
          }
          cb(null, true);
      }
  });

// ─────────────────────────────────────────────────────────
//  GET /public/listings
//  No auth. Returns all opted-in properties with live
//  vacancy counts. Supports optional query params:
//    ?location=westlands   (case-insensitive partial match)
//    ?minRent=10000
//    ?maxRent=25000
// ─────────────────────────────────────────────────────────
//
//  isActive  = landlord's internal toggle to enable/disable
//             a property within their SaaS account context.
//             Has nothing to do with public visibility.
//
//  isListed  = landlord explicitly opted this property into
//             the public discovery page.
//
//  isApproved = admin/stacklord moderation gate — prevents
//             properties appearing publicly before review.
//
//  A property should appear publicly ONLY when BOTH
//  isListed === true AND isApproved === true.
// ─────────────────────────────────────────────────────────

app.get('/public/listings', async (req, res) => {
    try {
        const { location, minRent, maxRent, page, limit } = req.query;

        const pageNum  = Math.max(1, parseInt(page)  || 1);
        const limitNum = Math.min(50, parseInt(limit) || 50); // default: return up to 50 (frontend paginates)

        // ── Base query: opted-in AND approved properties only ──
        // isActive is intentionally excluded — it controls the landlord's
        // internal property context switcher, not public visibility.
            const propertyQuery = {
            isListed:    true,
            isApproved:  true,
            isSuspended: { $ne: true }
        };

        if (location && location.trim()) {
            propertyQuery.location = { $regex: location.trim(), $options: 'i' };
        }

        const properties = await Property.find(propertyQuery)
            .select('name location phone description photos createdAt landlord geo formattedAddress')
            .sort({ createdAt: -1 })
            .lean();

        // ── Enrich each property with live house stats ──
        const listings = await Promise.all(properties.map(async (prop) => {
            const houseQuery = { property: prop._id };
            if (minRent || maxRent) {
                houseQuery.rent = {};
                if (minRent) houseQuery.rent.$gte = Number(minRent);
                if (maxRent) houseQuery.rent.$lte = Number(maxRent);
            }

            const [allHouses, vacantCount] = await Promise.all([
                House.find(houseQuery).select('rent status').lean(),
                House.countDocuments({ ...houseQuery, status: 'available' })
            ]);

            // If rent filter is active and no matching houses → exclude property
            if ((minRent || maxRent) && allHouses.length === 0) return null;

            const rents = allHouses.map(h => h.rent).filter(Boolean);

            return {
                _id:              prop._id,
                name:             prop.name,
                location:         prop.location    || '—',
                phone:            prop.phone       || null,
                description:      prop.description || '',
                photos:           prop.photos      || [],
                createdAt:        prop.createdAt,
                geo:              prop.geo              || null,
                formattedAddress: prop.formattedAddress || null,
                totalHouses:      allHouses.length,
                vacantCount,
                rentRange: rents.length
                    ? { min: Math.min(...rents), max: Math.max(...rents) }
                    : null
            };
        }));

        res.json(listings.filter(Boolean));

    } catch (err) {
        console.error('GET /public/listings error:', err.message);
        res.status(500).json({ message: 'Failed to load listings' });
    }
});

app.get('/public/listings/nearby', async (req, res) => {
    try {
        const { swLat, swLng, neLat, neLng } = req.query;
        const bounds = [swLat, swLng, neLat, neLng].map(Number);
 
        if (bounds.some(n => !Number.isFinite(n))) {
            return res.status(400).json({ message: 'swLat, swLng, neLat, neLng are all required' });
        }
        const [sLat, sLng, nLat, nLng] = bounds;
 
        const properties = await Property.find({
            isListed:   true,
            isApproved: true,
            geo: {
                $geoWithin: {
                    // GeoJSON order — [lng, lat] — matches how `geo` is stored
                    $box: [[sLng, sLat], [nLng, nLat]]
                }
            }
        })
            .select('name location geo formattedAddress phone description photos')
            .lean();
 
        res.json(properties);
 
    } catch (err) {
        console.error('GET /public/listings/nearby error:', err.message);
        res.status(500).json({ message: 'Failed to load nearby listings' });
    }
});


// ─────────────────────────────────────────────────────────
//  PUT /properties/:id/listing
//
//  Landlord toggles public visibility + sets description.
//  isApproved is admin-only — landlord cannot set it here.
//  isActive is NOT touched — wrong field for this purpose.
// ─────────────────────────────────────────────────────────

app.put('/properties/:id/listing', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (property.isSuspended && req.body.isListed === true) {
            return res.status(403).json({
                message: `${property.name} is suspended — settle the outstanding commission before making it publicly visible again.`
            });
        }

                if (typeof req.body.isListed === 'boolean') {
            property.isListed = req.body.isListed;

            // FIX (auto-approve toggle): if the stacklord has enabled
            // auto-approval, skip the pending-review queue entirely when a
            // landlord opts a property into public listings. Never auto-
            // un-approves — toggling isListed off just hides it, existing
            // approval state is left alone either way.
            if (property.isListed) {
                const settings = await getPlatformSettings();
                if (settings.autoApproveListings) {
                    property.isApproved = true;
                }
            }
        }
        if (typeof req.body.description === 'string') {
            property.description = req.body.description.trim();
        }

        await property.save();

        // Tell landlord whether it will appear publicly or is pending approval
        let statusMsg;
        if (property.isListed && property.isApproved) {
            statusMsg = `${property.name} is now publicly visible ✅`;
        } else if (property.isListed && !property.isApproved) {
            statusMsg = `${property.name} is listed — pending admin approval before it appears publicly`;
        } else {
            statusMsg = `${property.name} has been removed from public listings`;
        }

        res.json({
            message:  statusMsg,
            property: {
                _id:         property._id,
                name:        property.name,
                isListed:    property.isListed,
                isApproved:  property.isApproved,
                description: property.description,
                photos:      property.photos
            }
        });

    } catch (err) {
        console.error('PUT /properties/:id/listing error:', err.message);
        res.status(500).json({ message: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  POST /properties/:id/photos
//  Upload one photo (multipart/form-data, field name: photo).
//  Max 5 photos per property — enforced here and in the model.
//  Requires: multer + cloudinary (see setup block at top).
// ─────────────────────────────────────────────────────────
const { fileTypeFromBuffer } = require('file-type');

app.post('/properties/:id/photos', authMiddleware, landlordOnly, _photoUpload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        // Verify the actual file signature, not just the client-supplied Content-Type
        const detected = await fileTypeFromBuffer(req.file.buffer);
        if (!detected || !detected.mime.startsWith('image/')) {
            return res.status(400).json({ message: 'File is not a valid image' });
        }

        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
       
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (property.photos.length >= 5) {
            return res.status(400).json({
                message: 'Maximum 5 photos per property. Delete one before uploading more.'
            });
        }

        // Upload buffer to Cloudinary
        const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder:         'rentportal/properties',
                    transformation: [{ width: 1200, height: 800, crop: 'fill', quality: 'auto' }]
                },
                (error, result) => {
                    if (error) reject(error);
                    else       resolve(result);
                }
            );
            stream.end(req.file.buffer);
        });

        property.photos.push(uploadResult.secure_url);
        await property.save();

        res.json({
            message:  'Photo uploaded ✅',
            photoUrl: uploadResult.secure_url,
            photos:   property.photos
        });

    } catch (err) {
        console.error('POST /properties/:id/photos error:', err.message);
        res.status(500).json({ message: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  DELETE /properties/:id/photos
//  Remove one photo by its URL. Deletes from Cloudinary too.
//  Body: { photoUrl: "https://res.cloudinary.com/..." }
// ─────────────────────────────────────────────────────────
app.delete('/properties/:id/photos', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const { photoUrl } = req.body;
        if (!photoUrl) return res.status(400).json({ message: 'photoUrl is required' });

        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (!property.photos.includes(photoUrl)) {
            return res.status(404).json({ message: 'Photo not found on this property' });
        }

        // Extract the Cloudinary public_id from the URL so we can delete it from storage.
        // Cloudinary URLs look like: .../rentportal/properties/abc123.jpg
        // The public_id is everything after /upload/vXXX/ and before the extension.
        const urlParts  = photoUrl.split('/');
        const uploadIdx = urlParts.indexOf('upload');
        // Skip the version segment (v1234567) that follows 'upload'
        const publicId  = urlParts
            .slice(uploadIdx + 2)
            .join('/')
            .replace(/\.[^/.]+$/, ''); // strip extension

        // Delete from Cloudinary (fire and forget — don't let a Cloudinary error
        // block the DB update; the URL would just be a dead link anyway)
        cloudinary.uploader.destroy(publicId).catch(err =>
            console.error('Cloudinary delete error:', err.message)
        );

        // Remove from property document
        property.photos = property.photos.filter(p => p !== photoUrl);
        await property.save();

        res.json({
            message: 'Photo removed ✅',
            photos:  property.photos
        });

    } catch (err) {
        console.error('DELETE /properties/:id/photos error:', err.message);
        res.status(500).json({ message: err.message });
    }
});


// ═══════════════════════════════════════════════════════
//  INQUIRY ROUTES
//
//  These routes allow anyone (no auth) to submit inquiries about a listed property.
// ═══════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────
//  POST /public/inquiries
//  No auth. Called from the public listings page.
//  Rate-limit: 3 inquiries per IP per 15 min (simple in-memory).
// ─────────────────────────────────────────────────────────


// Simple in-memory rate limiter for inquiry submissions
const _inquiryRateLimit = new Map();  // key: IP → { count, windowStart }

function _checkInquiryRateLimit(ip) {
    const now    = Date.now();
    const window = 15 * 60 * 1000; // 15 min
    const max    = 5;               // 5 inquiries per IP per window

    const entry = _inquiryRateLimit.get(ip);
    if (!entry || (now - entry.windowStart) > window) {
        _inquiryRateLimit.set(ip, { count: 1, windowStart: now });
        return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
}

app.post('/public/inquiries', async (req, res) => {
    try {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';

        if (!_checkInquiryRateLimit(ip)) {
            return res.status(429).json({
                message: 'Too many inquiries submitted. Please wait 15 minutes before trying again.'
            });
        }

        const propertyId = req.body.propertyId || '';
        const name       = sanitize(req.body.name    || '');
        const phone      = sanitize(req.body.phone   || '');
        const email      = sanitize(req.body.email   || '').toLowerCase() || null;
        const message    = sanitize(req.body.message || '', 1000);

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });
        if (!name)       return res.status(400).json({ message: 'Name is required' });
        if (!phone)      return res.status(400).json({ message: 'Phone number is required' });
        if (!message)    return res.status(400).json({ message: 'Message is required' });

        // Verify property is publicly listed AND approved for public discovery
        // isActive is a per-landlord property toggle (enable/disable within their account),
        // NOT a public visibility flag — do not use it here.
        const property = await Property.findOne({
            _id:        propertyId,
            isListed:   true,
            isApproved: true
        }).select('landlord name location');

        if (!property) {
            return res.status(404).json({ message: 'Property not found or not publicly listed' });
        }

        const inquiry = await Inquiry.create({
            property: property._id,
            landlord: property.landlord,
            name,
            phone,
            email:   email || null,
            message,
            status: 'new'
        });

        // Optional: notify landlord via email (fire-and-forget)
        try {
            const User = require('./models/User');
            const landlord = await User.findById(property.landlord).select('name email');
            if (landlord && landlord.email) {
                const { Resend } = require('resend');
                const resend = new Resend(process.env.RESEND_API_KEY);
                await resend.emails.send({
                    from:    'Affordable Rentals 🏠 <support@affordablerentals.site>',
                    to:      landlord.email,
                    subject: `📩 New Inquiry — ${property.name}`,
                    html: `
                    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                      <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:28px 32px;text-align:center">
                        <div style="font-size:36px;margin-bottom:8px">📩</div>
                        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">New Property Inquiry</h1>
                        <p style="color:#bae6fd;margin:6px 0 0;font-size:13px">${property.name}${property.location ? ' · ' + property.location : ''}</p>
                      </div>
                      <div style="padding:28px 32px">
                        <p style="color:#1e293b;font-size:15px;margin:0 0 16px">Hi <strong>${landlord.name.split(' ')[0]}</strong>,</p>
                        <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 20px">
                          Someone is interested in <strong>${property.name}</strong> and sent the following inquiry through your public listing.
                        </p>
                        <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px 24px;margin-bottom:24px">
                          <table style="width:100%;border-collapse:collapse">
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0;width:90px">Name</td>       <td style="color:#1e293b;font-size:13px;font-weight:600">${name}</td></tr>
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0">Phone</td>      <td style="color:#1e293b;font-size:13px;font-weight:600">${phone}</td></tr>
                            ${email ? `<tr><td style="color:#64748b;font-size:13px;padding:6px 0">Email</td><td style="color:#1e293b;font-size:13px;font-weight:600">${email}</td></tr>` : ''}
                            <tr><td style="color:#64748b;font-size:13px;padding:6px 0;vertical-align:top">Message</td><td style="color:#1e293b;font-size:13px;line-height:1.6">${message}</td></tr>
                          </table>
                        </div>
                        <div style="display:flex;gap:12px;flex-wrap:wrap">
                          <a href="tel:${phone}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600">📞 Call Now</a>
                          <a href="https://wa.me/${phone.replace(/[^0-9]/g,'').replace(/^0/,'254')}?text=${encodeURIComponent(`Hi ${name}, I'm ${landlord.name} from ${property.name}. Thanks for your inquiry!`)}" style="display:inline-block;background:#25d366;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600">💬 WhatsApp</a>
                        </div>
                      </div>
                      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 32px;text-align:center">
                        <p style="color:#cbd5e1;font-size:11px;margin:0">You can manage all inquiries from your <strong>Landlord Dashboard → Inquiries</strong></p>
                      </div>
                    </div>`
                });
            }
        } catch (emailErr) {
            console.error('Inquiry notification email failed:', emailErr.message);
        }

        res.status(201).json({
            message: 'Inquiry submitted successfully ✅',
            inquiryId: inquiry._id
        });

    } catch (err) {
        console.error('POST /public/inquiries error:', err.message);
        res.status(500).json({ message: 'Failed to submit inquiry. Please try again.' });
    }
});


// ─────────────────────────────────────────────────────────
//  GET /inquiries
//  Landlord — list inquiries for their properties.
//  Query: ?propertyId=, ?status=new|read|contacted|archived
//  Paginated: ?page=1&limit=20
// ─────────────────────────────────────────────────────────

app.get('/inquiries', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const query  = { landlord: req.user.id };
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(50, parseInt(req.query.limit) || 20);
        const skip   = (page - 1) * limit;

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        }

        if (req.query.status) {
            query.status = req.query.status;
        }

        const [inquiries, total] = await Promise.all([
            Inquiry.find(query)
                .populate('property', 'name location')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Inquiry.countDocuments(query)
        ]);

        // Count unread separately for badge
        const unreadCount = await Inquiry.countDocuments({ landlord: req.user.id, status: 'new' });

        res.json({
            inquiries,
            total,
            page,
            pages:        Math.ceil(total / limit),
            unreadCount
        });

    } catch (err) {
        console.error('GET /inquiries error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  GET /inquiries/unread-count
//  Fast badge count for sidebar — landlord only.
// ─────────────────────────────────────────────────────────

app.get('/inquiries/unread-count', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const count = await Inquiry.countDocuments({
            landlord: req.user.id,
            status:   'new'
        });
        res.json({ count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  PUT /inquiries/:id/status
//  Update inquiry status: new → read → contacted → archived
// ─────────────────────────────────────────────────────────

app.put('/inquiries/:id/status', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const { status, notes } = req.body;
        const allowed = ['new', 'read', 'contacted', 'archived'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ message: `Status must be one of: ${allowed.join(', ')}` });
        }

        const inquiry = await Inquiry.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!inquiry) return res.status(404).json({ message: 'Inquiry not found' });

        inquiry.status = status;
        if (typeof notes === 'string') inquiry.notes = sanitize(notes, 500);
        await inquiry.save();

        res.json({ message: 'Inquiry updated ✅', inquiry });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  DELETE /inquiries/:id
//  Landlord deletes an inquiry.
// ─────────────────────────────────────────────────────────

app.delete('/inquiries/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const inquiry = await Inquiry.findOneAndDelete({ _id: req.params.id, landlord: req.user.id });
        if (!inquiry) return res.status(404).json({ message: 'Inquiry not found' });
        res.json({ message: 'Inquiry deleted ✅' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════
// CRON — COMMISSION DUE REMINDERS (1st of each month, 9 AM)
// ═══════════════════════════════════════
//
// Runs once the previous month has fully closed. Anything still unpaid
// for that month gets one email + one activity log entry per property.
// Nothing here suspends or restricts the account — it's a notice only,
// matching the platform's current "free forever, commission-based" model.

async function checkCommissionDue() {
    const previousMonth = getMonthLabel(-1);
    console.log(`🕘 Checking unpaid commission for ${previousMonth}...`);

    try {
        const properties = await Property.find({})
            .populate('landlord', 'name email accountStatus');

        for (const prop of properties) {
            if (!prop.landlord || prop.landlord.accountStatus !== 'active') continue;

            const { amountDue } = await computeCommissionForProperty(prop._id, previousMonth);
            if (amountDue <= 0) continue;

            const alreadyPaid = await CommissionPayment.findOne({
                property: prop._id, month: previousMonth, status: 'paid'
            });
            if (alreadyPaid) continue;

            sendCommissionDueEmail({
                name:     prop.landlord.name,
                email:    prop.landlord.email,
                property: prop.name,
                month:    previousMonth,
                amountDue
            }).catch(err => console.error(`Commission due email failed for ${prop.landlord.email}:`, err.message));

            logActivity({
                landlord: prop.landlord._id,
                property: prop._id,
                action:   'commission.due_reminder',
                message:  `Commission of Ksh ${Number(amountDue).toLocaleString()} due for ${prop.name} (${previousMonth})`,
                meta:     { amountDue, month: previousMonth },
                actor:    'system'
            });
        }

        console.log('✅ Commission due check complete');
    } catch (err) {
        console.error('checkCommissionDue error:', err.message);
    }
}

cron.schedule('0 9 1 * *', () => { checkCommissionDue(); });

// ═══════════════════════════════════════
// CRON — AUTO-SUSPEND OVERDUE PROPERTIES (daily, 9:30 AM)
// ═══════════════════════════════════════
//
// Grace period: 7 days after a month closes. Skips properties whose
// landlord is already suspended at the account level (already fully
// blocked, nothing more to do) and properties already suspended.

async function checkCommissionAutoSuspend() {
    console.log('🕤 Checking overdue commission for auto-suspension...');

    try {
        const properties = await Property.find({ isSuspended: { $ne: true } })
            .populate('landlord', 'name email accountStatus');

        for (const prop of properties) {
            if (!prop.landlord || prop.landlord.accountStatus === 'suspended') continue;

            const overdue = await getOverdueCommissionMonths(prop._id, 7);
            if (!overdue.length) continue;

            const totalOwed  = overdue.reduce((sum, o) => sum + o.amountDue, 0);
            const monthsList = overdue.map(o => o.month);

            prop.isSuspended     = true;
            prop.suspendedReason = `Unpaid commission for ${monthsList.join(', ')} (Ksh ${totalOwed.toLocaleString()})`;
            prop.suspendedAt     = new Date();
            prop.suspendedBy     = 'system';
            await prop.save();

            sendPropertySuspendedEmail({
                name:     prop.landlord.name,
                email:    prop.landlord.email,
                property: prop.name,
                months:   monthsList,
                totalOwed
            }).catch(err => console.error(`Suspension email failed for ${prop.landlord.email}:`, err.message));

            logActivity({
                landlord: prop.landlord._id,
                property: prop._id,
                action:   'property.auto_suspended',
                message:  `${prop.name} auto-suspended — unpaid commission for ${monthsList.join(', ')} (Ksh ${totalOwed.toLocaleString()})`,
                meta:     { overdue, totalOwed },
                actor:    'system'
            });

            console.log(`🚫 Suspended ${prop.name} — Ksh ${totalOwed.toLocaleString()} overdue`);
        }

        console.log('✅ Auto-suspend check complete');
    } catch (err) {
        console.error('checkCommissionAutoSuspend error:', err.message);
    }
}

cron.schedule('30 9 * * *', () => { checkCommissionAutoSuspend(); });

// ═══════════════════════════════════════
// CRON — RENT REMINDERS (daily 9 AM)
// ═══════════════════════════════════════

// FIX Bug 18: track last reminder sent per tenant per month to avoid daily spam
async function checkArrears() {
    const today      = new Date();
    const currentDay = today.getDate();
    const month      = today.toLocaleString('default', { month: 'long', year: 'numeric' });
    const todayKey   = today.toISOString().slice(0, 10); // YYYY-MM-DD

    console.log(`🕘 Running rent check for ${month}...`);

    try {
        // FIX (plans → commission migration): active landlords are simply
        // those not suspended — no more trial/active/grace lifecycle to filter on.
        const activeLandlords = await User.find({
            role:          'landlord',
            accountStatus: 'active'
        }).select('_id');

        const landlordIds = activeLandlords.map(l => l._id);
        const tenants     = await Tenant.find({
            landlord: { $in: landlordIds },
            status:   'active'
        }).populate('house');

        for (const tenant of tenants) {
            if (!tenant.house)               continue;
            if (currentDay < tenant.dueDate) continue;

            const rent    = tenant.house.rent;

            // Batch check: look for any paid/partial payment this month
            const paid = await Payment.findOne({
                tenant: tenant._id,
                month,
                status: { $in: ['paid', 'partial'] }
            });

            // If fully paid, skip
            const totalPaid = paid ? (await Payment.aggregate([
                { $match: { tenant: tenant._id, month, status: { $in: ['paid', 'partial'] } } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]))[0]?.total || 0 : 0;

            const balance = Math.max(0, rent - totalPaid);
            if (balance === 0) continue;

            // FIX Bug 18: check if we already sent a reminder today for this tenant+month
            const reminderKey = `${tenant._id}:${month}:${todayKey}`;
            if (reminderLog.has(reminderKey)) continue;

            console.log(`⚠️  ${tenant.name} — balance Ksh ${balance} for ${month} — sending reminder`);

            sendRentReminder({
                name:    tenant.name,
                email:   tenant.email,
                house:   tenant.house.name,
                rent:    tenant.house.rent,
                month,
                dueDate: tenant.dueDate,
                arrears: balance
            }).catch(err =>
                console.error(`Reminder email failed for ${tenant.name}:`, err.message)
            );

            // Mark as sent for today so subsequent cron runs / re-checks this
            // same day skip this tenant. Map is small and short-lived — it's
            // fine to just let it grow across a single day and reset on redeploy.
            reminderLog.set(reminderKey, true);
        }

        console.log('✅ Rent check complete');

    } catch (err) {
        console.error('checkArrears error:', err.message);
    }
}

// FIX Bug 19 note: cron runs on this single instance.
// For multi-instance deployments use a distributed lock (e.g. Redis SETNX)
// or a dedicated job queue (Bull/BullMQ) to prevent duplicate sends.
cron.schedule('0 9 * * *', () => { checkArrears(); });


// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT} 🚀`);
});