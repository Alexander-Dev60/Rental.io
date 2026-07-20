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
const mongoose    = require('mongoose');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const Inquiry = require('./models/Inquiry');

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
        sendListingApprovalEmail
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
const TenantMembership    = require('./models/TenantMembership');
const Property            = require('./models/Property');

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

// ── Rent-reminder dedupe store { "tenantId:month:YYYY-MM-DD": true } ── (FIX Bug 18)
// The cron checks this before sending so a tenant only gets one reminder per
// day even though the underlying arrears check re-runs every day until paid.
// In-memory is fine on a single Render instance; keys are cheap and self-limiting
// since only "today"'s key is ever written/read.
const reminderLog = new Map();

// ── Sanitize a string field: trim and cap length ── (FIX Bug 22)
function sanitize(value, maxLen = 500) {
    if (typeof value !== 'string') return value;
    return value.trim().slice(0, maxLen);
}

// ═══════════════════════════════════════
// SUBSCRIPTION PLAN LIMITS
// ═══════════════════════════════════════
//
// Trial is now a real (hidden) SubscriptionPlan document — see seedPlans.js —
// assigned to `subscriptionPlan` at registration below. This constant is only
// a fallback for landlords created BEFORE that migration (subscriptionPlan
// still null in the DB). Keep these numbers in sync with the seeded "Trial"
// plan (maxProperties: 1, maxTenantsPerProperty: 20) if you ever change one.
const TRIAL_FALLBACK_LIMITS = {
    maxProperties:         1,
    maxTenantsPerProperty: 20
};

// ── Resolve a landlord's effective plan limits ──
// Every landlord SHOULD have a subscriptionPlan (Trial or paid) after
// registration. This only falls back to TRIAL_FALLBACK_LIMITS for legacy
// accounts that predate assigning the seeded Trial plan at signup.
function getPlanLimits(landlord) {
    if (landlord.subscriptionPlan) {
        return {
            maxProperties:         landlord.subscriptionPlan.maxProperties,
            maxTenantsPerProperty: landlord.subscriptionPlan.maxTenantsPerProperty,
            planName:              landlord.subscriptionPlan.name
        };
    }
    return { ...TRIAL_FALLBACK_LIMITS, planName: 'Trial' };
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

function landlordOnly(req, res, next) {
    if (req.user.role !== 'landlord') {
        return res.status(403).json({ message: 'Landlords only' });
    }
    next();
}

async function checkSubscription(req, res, next) {
    if (req.user.role !== 'landlord') return next();

    try {
        const landlord = await User.findById(req.user.id).select(
            'subscriptionStatus subscriptionExpiry trialEndsAt gracePeriodUntil suspendedReason'
        );

        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        const now = new Date();

        if (landlord.subscriptionStatus === 'trial' && landlord.trialEndsAt && now > landlord.trialEndsAt) {
            landlord.subscriptionStatus = 'expired';
            landlord.gracePeriodUntil   = null;
            await landlord.save();
        }

        if (landlord.subscriptionStatus === 'active' && landlord.subscriptionExpiry && now > landlord.subscriptionExpiry) {
            landlord.subscriptionStatus = 'grace';
            landlord.gracePeriodUntil   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            await landlord.save();
        }

        if (landlord.subscriptionStatus === 'grace' && landlord.gracePeriodUntil && now > landlord.gracePeriodUntil) {
            landlord.subscriptionStatus = 'expired';
            await landlord.save();
        }

        switch (landlord.subscriptionStatus) {
            case 'trial':
            case 'active':
                return next();

            case 'grace':
                req.subscriptionWarning = {
                    status:  'grace',
                    message: `Your subscription has expired. You have until ${landlord.gracePeriodUntil.toDateString()} to renew before losing access.`,
                    until:   landlord.gracePeriodUntil
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
                    message:            `Your account has been suspended. Reason: ${landlord.suspendedReason || 'Contact support.'}`,
                    subscriptionStatus: 'suspended',
                    code:               'ACCOUNT_SUSPENDED'
                });

            default:
                return res.status(403).json({ message: 'Subscription status unknown.' });
        }
    } catch (err) {
        console.error('checkSubscription error:', err.message);
        next();
    }
}

// FIX Bug 20: timing-safe stacklord key comparison
function stacklordAuth(req, res, next) {
    const key        = req.headers['x-stacklord-key'] || req.query.key;
    const serverKey  = process.env.STACKLORD_KEY;

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
// bypassed by guessing a checkoutRequestId.
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

        // FIX: assign the seeded (hidden) Trial SubscriptionPlan so trial landlords
        // flow through the exact same plan.maxProperties / plan.maxTenantsPerProperty
        // checks as paying landlords, instead of every route special-casing "no plan".
        // If the plan hasn't been seeded yet (fresh DB, seedPlans.js not run), this
        // simply stays null and getPlanLimits() falls back to TRIAL_FALLBACK_LIMITS.
        const trialPlan = await SubscriptionPlan.findOne({ name: 'Trial' });

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
            subscriptionStatus: 'trial',
            subscriptionPlan:   trialPlan ? trialPlan._id : null,
            trialEndsAt:        new Date(Date.now() + (trialPlan?.durationDays || 14) * 24 * 60 * 60 * 1000),
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

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Wrong password' });

        if (user.role === 'landlord' && user.subscriptionStatus === 'suspended') {
            return res.status(403).json({
                message: `Your account has been suspended. Reason: ${user.suspendedReason || 'Contact support.'}`,
                code:    'ACCOUNT_SUSPENDED'
            });
        }

        // FIX Bug 23: guard JWT_SECRET
        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ message: 'Server configuration error' });

        if (user.role === 'tenant' && user.mustChangePassword) {
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

        const token = jwt.sign(
            {
                id:         user._id,
                role:       user.role,
                tenantId:   user.tenantId   || null,
                landlordId: user.landlordId || null
            },
            secret,
            { expiresIn: '2h' } // FIX: shortened from 7d — sliding session via /auth/refresh-token keeps active users logged in
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
        const user = await User.findById(req.user.id).select('role subscriptionStatus suspendedReason tenantId landlordId');
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (user.role === 'landlord' && user.subscriptionStatus === 'suspended') {
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
            .select('-password -mpesaConsumerKey -mpesaConsumerSecret -mpesaPasskey')
            .populate('subscriptionPlan');

        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        const properties = await Property.find({ landlord: req.user.id })
            .select('name location phone paymentConfigured isActive paybillNumber')
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
            subscriptionStatus: landlord.subscriptionStatus,
            subscriptionPlan:   landlord.subscriptionPlan,
            trialEndsAt:        landlord.trialEndsAt,
            subscriptionExpiry: landlord.subscriptionExpiry,
            daysRemaining:      landlord.daysRemaining,
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

// FIX: use getPlanLimits() instead of hard-blocking whenever subscriptionPlan
// is null. Trial landlords now carry the seeded Trial plan (assigned at
// registration above), so this is the same code path for trial and paid.
app.post('/properties/create', authMiddleware, landlordOnly, checkSubscription, async (req, res) => {
    try {
        const name     = sanitize(req.body.name     || '');
        const location = sanitize(req.body.location || '');
        const phone    = sanitize(req.body.phone    || '');

        if (!name) return res.status(400).json({ message: 'Property name is required' });

        const landlord = await User.findById(req.user.id).populate('subscriptionPlan');
        const { maxProperties, planName } = getPlanLimits(landlord);

        if (maxProperties !== -1) {
            const count = await Property.countDocuments({ landlord: req.user.id });
            if (count >= maxProperties) {
                return res.status(403).json({
                    message: `Your ${planName} plan allows ${maxProperties} ${maxProperties === 1 ? 'property' : 'properties'}. Upgrade to add more.`,
                    upgrade: true
                });
            }
        }

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
            TenantMembership.deleteMany({ property: req.params.id })
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

app.post('/tenants/create', authMiddleware, landlordOnly, checkSubscription, async (req, res) => {
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

        const landlordUser = await User.findById(req.user.id).populate('subscriptionPlan');

        // FIX: use getPlanLimits() instead of `plan && plan.maxTenantsPerProperty !== -1` —
        // that guard SKIPPED the tenant cap entirely whenever subscriptionPlan was null,
        // meaning trial landlords could previously add unlimited tenants to their one
        // property. Now trial resolves to the same 20-tenant cap as everyone else.
        const { maxTenantsPerProperty, planName } = getPlanLimits(landlordUser);

        if (maxTenantsPerProperty !== -1) {
            const tenantCount = await Tenant.countDocuments({ property: propertyId, status: 'active' });
            if (tenantCount >= maxTenantsPerProperty) {
                return res.status(403).json({
                    message: `Your ${planName} plan allows ${maxTenantsPerProperty} tenants per property. Upgrade to add more.`,
                    upgrade: true
                });
            }
        }

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
                isReturning:  true,
                propertyName: property.name,
                landlordName: landlordUser.name
            }).catch(err => console.error('Notification email failed:', err.message));
        }

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

// FIX: added checkSubscription — this route had NO subscription gating at all,
// meaning a suspended or expired landlord could still create houses even though
// /properties/create and /tenants/create both correctly blocked them. Houses are
// the actual billable unit of inventory here, so this was the biggest gap.
app.post('/houses', authMiddleware, landlordOnly, checkSubscription, async (req, res) => {
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

            const houses = await House.find(query).populate('property', 'name');
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

app.post('/payments', authMiddleware, landlordOnly, checkSubscription, async (req, res) => {
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
app.get('/dashboard/:month', authMiddleware, landlordOnly, checkSubscription, async (req, res) => {
    try {
        const month       = req.params.month;
        const tenantQuery = { landlord: req.user.id, status: 'active' };
        const houseQuery  = { landlord: req.user.id };
        let   propertyInfo = null;

        if (req.query.propertyId) {
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: req.user.id });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            tenantQuery.property = req.query.propertyId;
            houseQuery.property  = req.query.propertyId;
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

        const landlord = await User.findById(req.user.id)
            .select('name propertyName propertyLocation paymentConfigured subscriptionStatus trialEndsAt subscriptionExpiry gracePeriodUntil');

        res.json({
            month,
            totalIncome,
            totalArrears,
            totalTenants:      tenants.length,
            totalHouses:       houses.length,
            occupiedHouses:    occupied,
            vacantHouses:      houses.length - occupied,
            paymentConfigured: landlord.paymentConfigured,
            property:          propertyInfo,
            landlordProfile: {
                name:             landlord.name,
                propertyName:     landlord.propertyName,
                propertyLocation: landlord.propertyLocation
            },
            warning: req.subscriptionWarning || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// SUBSCRIPTION SYSTEM
// ═══════════════════════════════════════

app.get('/subscription-status', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const landlord = await User.findById(req.user.id)
            .select('-password -mpesaConsumerKey -mpesaConsumerSecret -mpesaPasskey')
            .populate('subscriptionPlan');

        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        const now           = new Date();
        let   expiryDate    = null;
        let   daysRemaining = 0;

        if (landlord.subscriptionStatus === 'trial')  expiryDate = landlord.trialEndsAt;
        if (landlord.subscriptionStatus === 'active') expiryDate = landlord.subscriptionExpiry;
        if (landlord.subscriptionStatus === 'grace')  expiryDate = landlord.gracePeriodUntil;

        if (expiryDate) {
            daysRemaining = Math.max(0, Math.ceil((new Date(expiryDate) - now) / (1000 * 60 * 60 * 24)));
        }

        const lastPayment = await SubscriptionPayment.findOne({ landlord: landlord._id, status: 'paid' })
            .sort({ paidAt: -1 })
            .populate('plan', 'name price');

        res.json({
            subscriptionStatus:      landlord.subscriptionStatus,
            subscriptionPlan:        landlord.subscriptionPlan,
            subscriptionExpiry:      landlord.subscriptionExpiry,
            trialEndsAt:             landlord.trialEndsAt,
            gracePeriodUntil:        landlord.gracePeriodUntil,
            lastSubscriptionPayment: landlord.lastSubscriptionPayment,
            suspendedReason:         landlord.suspendedReason,
            landlordPhone:           landlord.landlordPhone,
            daysRemaining,
            lastPayment:             lastPayment || null,
            warning:                 req.subscriptionWarning || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/subscription-plans', async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1, price: 1 });
        res.json(plans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/subscribe', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const planId = req.body.planId || '';
        const phone  = sanitize(req.body.phone || '');

        if (!planId || !phone) {
            return res.status(400).json({ message: 'planId and phone are required' });
        }

        const plan = await SubscriptionPlan.findById(planId);
        if (!plan || !plan.isActive) {
            return res.status(404).json({ message: 'Plan not found or inactive' });
        }

        const landlord = await User.findById(req.user.id);
        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        if (!landlord.landlordPhone) {
            landlord.landlordPhone = phone;
            await landlord.save();
        }

        const token     = await getSystemToken();
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password  = Buffer.from(
            process.env.SYSTEM_PAYBILL + process.env.SYSTEM_PASSKEY + timestamp
        ).toString('base64');

        // FIX: normalize phone before sending to Safaricom
        const normalizedPhone = normalizePhone(phone);
        // FIX: Safaricom requires a whole-number amount
        const stkAmount = Math.ceil(Number(plan.price));

        const stkRes = await axios.post(
            `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
            {
                BusinessShortCode: process.env.SYSTEM_PAYBILL,
                Password:          password,
                Timestamp:         timestamp,
                TransactionType:   'CustomerPayBillOnline',
                Amount:            stkAmount,
                PartyA:            normalizedPhone,
                PartyB:            process.env.SYSTEM_PAYBILL,
                PhoneNumber:       normalizedPhone,
                CallBackURL:       `${process.env.BASE_URL}/subscription-callback/${process.env.MPESA_CALLBACK_SECRET}`,
                AccountReference:  `Sub-${plan.name}`,
                TransactionDesc:   `${plan.name} subscription — Affordable Rentals`
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const data = stkRes.data;

        if (data.ResponseCode !== '0') {
            return res.status(400).json({ message: data.ResponseDescription || 'STK push failed', data });
        }

        await SubscriptionPayment.create({
            landlord:          landlord._id,
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
        res.status(500).json({ error: 'Subscription payment failed', details: err.response?.data || err.message });
    }
});

// FIX Bug 14: same secret-path protection as /callback above.
app.post('/subscription-callback/:secret', async (req, res) => {
    if (!validateCallbackSecret(req, res)) return;

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

            const now      = new Date();
            const landlord = subPayment.landlord;
            const plan     = subPayment.plan;

            let baseDate = now;
            if (landlord.subscriptionStatus === 'active' && landlord.subscriptionExpiry && landlord.subscriptionExpiry > now) {
                baseDate = landlord.subscriptionExpiry;
            }

            const newExpiry = new Date(baseDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

            subPayment.status    = 'paid';
            subPayment.mpesaCode = mpesaCode;
            subPayment.paidAt    = now;
            subPayment.expiresAt = newExpiry;
            await subPayment.save();

            await User.findByIdAndUpdate(landlord._id, {
                subscriptionStatus:      'active',
                subscriptionPlan:        plan._id,
                subscriptionExpiry:      newExpiry,
                gracePeriodUntil:        null,
                suspendedReason:         null,
                lastSubscriptionPayment: now
            });

            console.log(`✅ Subscription confirmed: ${mpesaCode} | ${plan.name} | Expires: ${newExpiry.toDateString()}`);

        sendSubscriptionRenewalEmail({
            landlord,
            plan,
            newExpiry,
            mpesaCode
        }).catch(err => console.error('Subscription email failed:', err.message));
        

        } else {
            subPayment.status = 'failed';
            await subPayment.save();
            console.log(`❌ Subscription payment failed — ResultCode: ${resultCode}`);
        }

    } catch (err) {
        console.error('Subscription callback error:', err.message);
    }
});

// Legacy path with no secret — reject cleanly.
app.post('/subscription-callback', (req, res) => res.status(404).end());

app.get('/subscription-status-poll/:checkoutRequestId', authMiddleware, landlordOnly, async (req, res) => {
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
            paidAt:    payment.paidAt    || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


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
        const totalPayments   = await SubscriptionPayment.countDocuments({ status: 'paid' });

        const revenueResult = await SubscriptionPayment.aggregate([
            { $match: { status: 'paid' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalRevenue = revenueResult[0]?.total || 0;

        const byStatus = await User.aggregate([
            { $match: { role: 'landlord' } },
            { $group: { _id: '$subscriptionStatus', count: { $sum: 1 } } }
        ]);

        res.json({
            stats: {
                totalLandlords,
                totalTenants,
                totalHouses,
                totalProperties,
                totalRevenue,
                totalPayments,
                byStatus
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
            .populate('subscriptionPlan')
            .sort({ createdAt: -1 });

        const enriched = await Promise.all(landlords.map(async l => {
            const tenantCount   = await Tenant.countDocuments({ landlord: l._id });
            const houseCount    = await House.countDocuments({ landlord: l._id });
            const propertyCount = await Property.countDocuments({ landlord: l._id });
            return { ...l.toJSON(), tenantCount, houseCount, propertyCount };
        }));

        res.json(enriched);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/stacklord/subscription-payments', stacklordAuth, async (req, res) => {
    try {
        const payments = await SubscriptionPayment.find()
            .populate('plan', 'name price durationDays')
            .populate('landlord', 'name email propertyName')
            .sort({ createdAt: -1 });
        res.json(payments);
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
                subscriptionStatus: 'suspended',
                suspendedReason:    reason,
                suspendedAt:        new Date(),
                suspendedBy:        'stacklord'
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
        const landlord = await User.findOne({ _id: req.params.landlordId, role: 'landlord' });
        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        const now       = new Date();
        let   newStatus = 'trial';

        if (landlord.subscriptionExpiry && landlord.subscriptionExpiry > now) {
            newStatus = 'active';
        } else if (landlord.trialEndsAt && landlord.trialEndsAt > now) {
            newStatus = 'trial';
        } else {
            newStatus = 'expired';
        }

        await User.findByIdAndUpdate(landlord._id, {
            subscriptionStatus: newStatus,
            suspendedReason:    null,
            suspendedAt:        null,
            suspendedBy:        null
        });

        res.json({ message: `Landlord unsuspended ✅ — Status restored to: ${newStatus}` });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// FIX Bug 21: validate days, handle null plan gracefully
app.post('/stacklord/extend/:landlordId', stacklordAuth, async (req, res) => {
    try {
        const days = parseInt(req.body.days);
        const note = sanitize(req.body.note || '', 300);

        if (!days || days < 1) return res.status(400).json({ message: 'days must be a positive number' });

        const landlord = await User.findOne({ _id: req.params.landlordId, role: 'landlord' });
        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        const now       = new Date();
        const base      = (landlord.subscriptionExpiry && landlord.subscriptionExpiry > now)
                          ? landlord.subscriptionExpiry
                          : now;
        const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

        await User.findByIdAndUpdate(landlord._id, {
            subscriptionStatus: 'active',
            subscriptionExpiry: newExpiry,
            gracePeriodUntil:   null,
            suspendedReason:    null
        });

        // FIX Bug 21: only create SubscriptionPayment if a plan exists;
        // set amount to 0 and mark clearly as manual extension
        const paymentDoc = {
            landlord:         landlord._id,
            amount:           0,
            durationDays:     days,
            status:           'paid',
            paidAt:           now,
            expiresAt:        newExpiry,
            manuallyExtended: true,
            manualNote:       note || `Manually extended by Stacklord for ${days} days`
        };

        // plan is required by schema — only attach if one exists
        if (landlord.subscriptionPlan) {
            paymentDoc.plan = landlord.subscriptionPlan;
        } else {
            // Assign a placeholder plan (the cheapest active one) to satisfy the required field
            const cheapestPlan = await SubscriptionPlan.findOne({ isActive: true }).sort({ price: 1 });
            if (cheapestPlan) paymentDoc.plan = cheapestPlan._id;
            // If no plan exists at all skip creating the payment record rather than crashing
        }

        if (paymentDoc.plan) {
            await SubscriptionPayment.create(paymentDoc);
        }

        res.json({
            message:   `Subscription extended by ${days} days ✅`,
            newExpiry: newExpiry.toDateString(),
            note:      note || null
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/stacklord/plans', stacklordAuth, async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find().sort({ sortOrder: 1 });
        res.json(plans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/stacklord/plans', stacklordAuth, async (req, res) => {
    try {
        const name                   = sanitize(req.body.name        || '', 100);
        const price                  = Number(req.body.price);
        const durationDays           = Number(req.body.durationDays);
        const description            = sanitize(req.body.description || '', 500);
        const features               = Array.isArray(req.body.features) ? req.body.features.map(f => sanitize(f, 200)) : [];
        const sortOrder              = Number(req.body.sortOrder)              || 0;
        const maxProperties          = req.body.maxProperties          ?? 1;
        const maxTenantsPerProperty  = req.body.maxTenantsPerProperty  ?? 20;

        if (!name || !price || !durationDays) {
            return res.status(400).json({ message: 'name, price and durationDays are required' });
        }

        const plan = await SubscriptionPlan.create({
            name,
            price,
            durationDays,
            description,
            features,
            sortOrder,
            maxProperties,
            maxTenantsPerProperty,
            createdBy: 'stacklord'
        });

        res.status(201).json({ message: 'Plan created ✅', plan });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// FIX Bug 22: whitelist plan update fields
app.put('/stacklord/plans/:id', stacklordAuth, async (req, res) => {
    try {
        const allowed = ['name', 'price', 'durationDays', 'description', 'features', 'sortOrder', 'maxProperties', 'maxTenantsPerProperty', 'isActive'];
        const updates = {};
        for (const field of allowed) {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        }

        const plan = await SubscriptionPlan.findByIdAndUpdate(req.params.id, updates, { returnDocument: "after" });
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json({ message: 'Plan updated ✅', plan });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/stacklord/plans/:id', stacklordAuth, async (req, res) => {
    try {
        const plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
        if (!plan) return res.status(404).json({ message: 'Plan not found' });
        res.json({ message: 'Plan deleted ✅' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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


// ─────────────────────────────────────────────────────────
//  POST /stacklord/properties/:id/approve
//  Admin approves or revokes a property's public listing.
//  Only stacklord can flip isApproved.
// ─────────────────────────────────────────────────────────

app.post('/stacklord/properties/:id/approve', stacklordAuth, async (req, res) => {
    try {
        const approve  = req.body.approve !== false; // default true
        const property = await Property.findByIdAndUpdate(
            req.params.id,
            { isApproved: approve },
            { new: true }
        ).select('name isListed isApproved landlord');

        if (!property) return res.status(404).json({ message: 'Property not found' });

        res.json({
            message:  approve
                ? `${property.name} approved for public listing ✅`
                : `${property.name} approval revoked`,
            property
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════
//  STACKLORD — Public Listings Management Routes
//  Add to server.js in the STACKLORD ROUTES section.
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
            { new: true }
        ).populate('landlord', 'name email').select('name isListed isApproved landlord location');

        if (!property) return res.status(404).json({ message: 'Property not found' });

        // Notify landlord
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
// ═══════════════════════════════════════════════════════
//  CORRECTED /public/listings route
//
//  Replace the existing propertyQuery block in server.js.
//
//  WHY:
//    isActive  = landlord's internal toggle to enable/disable
//               a property within their SaaS account context.
//               Has nothing to do with public visibility.
//
//    isListed  = landlord explicitly opted this property into
//               the public discovery page.
//
//    isApproved = admin/stacklord moderation gate — prevents
//               properties appearing publicly before review.
//
//  A property should appear publicly ONLY when BOTH
//  isListed === true AND isApproved === true.
// ═══════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────
//  GET /public/listings  (replace existing handler)
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
            isListed:   true,
            isApproved: true
        };

        if (location && location.trim()) {
            propertyQuery.location = { $regex: location.trim(), $options: 'i' };
        }

        const properties = await Property.find(propertyQuery)
            .select('name location phone description photos createdAt landlord')
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
                _id:         prop._id,
                name:        prop.name,
                location:    prop.location    || '—',
                phone:       prop.phone       || null,
                description: prop.description || '',
                photos:      prop.photos      || [],
                createdAt:   prop.createdAt,
                totalHouses: allHouses.length,
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


// ─────────────────────────────────────────────────────────
//  PUT /properties/:id/listing  (replace existing handler)
//
//  Landlord toggles public visibility + sets description.
//  isApproved is admin-only — landlord cannot set it here.
//  isActive is NOT touched — wrong field for this purpose.
// ─────────────────────────────────────────────────────────

app.put('/properties/:id/listing', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (typeof req.body.isListed === 'boolean') {
            property.isListed = req.body.isListed;
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
app.post('/properties/:id/photos', authMiddleware, landlordOnly, _photoUpload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

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
//  INQUIRY ROUTES — add to app.js
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

app.get('/inquiries', authMiddleware, landlordOnly, checkSubscription, async (req, res) => {
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
        const activeLandlords = await User.find({
            role:               'landlord',
            subscriptionStatus: { $in: ['trial', 'active', 'grace'] }
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