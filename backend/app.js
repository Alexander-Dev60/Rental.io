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
    'http://127.0.0.1:5502',
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
        sendLandlordWelcomeEmail,
        sendRentReminder,
        sendMoveOutEmail,
        sendPasswordResetEmail,
        sendTenantWelcomeEmail,
        sendCaretakerWelcomeEmail,
        sendPaymentOtpEmail,
        sendRentReceiptEmail,
        sendMpesaConfirmationEmail,
        sendHoldingFeeEmail,
        sendHolidayReturnEmail,
        sendPropertySuspendedEmail,
        sendListingApprovalEmail,
        sendCommissionDueEmail,
        emailIcon
} = require('./emails');

// ── Models ──
const Tenant              = require('./models/Tenant');
const TenantInvitation = require('./models/TenantInvitation');
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
const ReferralReward         = require('./models/ReferralReward');
const HouseGroup = require('./models/HouseGroup');
const Billing = require('./models/Billing');
const HolidayHold = require('./models/HolidayHold');
const TenantNotification = require('./models/TenantNotification');
const TenantStay  = require('./models/TenantStay');
const HouseApplication           = require('./models/HouseApplication');
const createAssigner             = require('./services/assignment');
const createTransferService      = require('./services/transfer');
const createBuildingHelpers      = require('./services/buildingHelpers');
const registerBuildingRoutes     = require('./routes/buildings');
const registerApplicationRoutes  = require('./routes/applications');
const createApplicationNotifiers = require('./emails.applications');

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

// ── Returns null for a landlord acting on their own dashboard (implied —
// no need to label it), or the caretaker's name so activity entries read
// "... — by <CaretakerName>" instead of just showing the property owner. ──
async function getActorName(req) {
    if (req.user.role !== 'caretaker') return null;
    const caretaker = await User.findById(req.user.id).select('name');
    return caretaker?.name || 'Caretaker';
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
                category: 'rent',                          // FIX: exclude deposits/refunds from commission base
                status: { $in: ['paid', 'partial'] }
            }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const rentCollected = agg[0]?.total || 0;

    // ── Net of mid-semester rent refunds tied to this same month — a refund
    //    is money physically paid back out, so it must never still count as
    //    "collected" for commission. refundContext: 'rent' scopes this to
    //    ONLY the mid-semester move-out refund flow — a deposit refund
    //    (refundContext left unset) never matches this query and so can
    //    never reduce commission. ──
    const refundAgg = await Payment.aggregate([
        {
            $match: {
                property: new mongoose.Types.ObjectId(propertyId),
                month,
                category: 'refund',
                refundContext: 'rent',
                billingCycle: 'semester',
                status: { $in: ['paid', 'partial'] }
            }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const rentRefunded = refundAgg[0]?.total || 0;

    const totalCollected = Math.max(0, rentCollected - rentRefunded);
    const settings        = await getPlatformSettings();
    const percentage      = settings.commissionPercentage;

    // Safaricom requires a whole-number STK amount — round up so a
    // fractional commission (e.g. 1234.50) never gets sent raw.
    let amountDue = Math.ceil(totalCollected * percentage / 100);
    let waived    = false;

    // ── Referral reward waiver ──
    // A landlord's reward is granted once, against them (not any one
    // property), and waives commission across their WHOLE portfolio for the
    // reward month — so we key the lookup off the property's landlord, not
    // the property itself. Because this is the one function every commission
    // read AND charge path calls, doing the override here means the summary
    // endpoint, the STK-push endpoint, and the overdue-check job all agree
    // automatically — nothing downstream needs its own "is this waived" logic.
    const property = await Property.findById(propertyId).select('landlord commissionCreditBalance').lean();
    if (property?.landlord) {
        const reward = await ReferralReward.findOne({ landlord: property.landlord, month }).select('_id').lean();
        if (reward) {
            amountDue = 0;
            waived    = true;
        }
    }

    // ── Commission credit from a previously-settled month's later refund.
    //    Read-only here — this function is the single source of truth for
    //    BOTH the display and the charge amount, so it must never mutate
    //    state itself. Actually consuming the credit happens only once a
    //    commission payment priced with it is confirmed paid. ──
    let creditApplied = 0;
    if (!waived && amountDue > 0) {
        const availableCredit = Number(property?.commissionCreditBalance || 0);
        creditApplied = Math.min(availableCredit, amountDue);
        amountDue     = amountDue - creditApplied;
    }

    return { totalCollected, percentage, amountDue, waived, creditApplied };
}

// ── Called right after a rent refund is recorded, and again as a safety
//    net right after a commission payment for a month is confirmed paid —
//    covers the race where a refund lands between STK push and
//    confirmation. Idempotent: only ever grants the INCREMENTAL delta above
//    what a given paid CommissionPayment record has already generated in
//    credit, so calling it any number of times for the same refund never
//    double-credits. ──
async function reconcileCommissionOverpayment(propertyId, month) {
    try {
        const paidRecord = await CommissionPayment.findOne({ property: propertyId, month, status: 'paid' })
            .sort({ paidAt: -1 });
        if (!paidRecord) return; // nothing settled yet for this month — nothing to reconcile

        const agg = await Payment.aggregate([
            { $match: { property: new mongoose.Types.ObjectId(propertyId), month, category: 'rent', status: { $in: ['paid', 'partial'] } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const rentCollected = agg[0]?.total || 0;

        const refundAgg = await Payment.aggregate([
            { $match: { property: new mongoose.Types.ObjectId(propertyId), month, category: 'refund', refundContext: 'rent', billingCycle: 'semester', status: { $in: ['paid', 'partial'] } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const rentRefunded = refundAgg[0]?.total || 0;

        const correctCollected = Math.max(0, rentCollected - rentRefunded);
        const correctAmountDue = Math.ceil(correctCollected * paidRecord.percentage / 100);

        const overpaid           = Math.max(0, paidRecord.amountDue - correctAmountDue);
        const incrementalCredit  = Math.max(0, overpaid - (paidRecord.creditGrantedForOverpayment || 0));
        if (incrementalCredit <= 0) return;

        await Property.findByIdAndUpdate(propertyId, { $inc: { commissionCreditBalance: incrementalCredit } });
        paidRecord.creditGrantedForOverpayment = (paidRecord.creditGrantedForOverpayment || 0) + incrementalCredit;
        await paidRecord.save();

        const property = await Property.findById(propertyId).select('landlord name');
        if (property) {
            logActivity({
                landlord: property.landlord,
                property: propertyId,
                action:   'commission.overpayment_credited',
                message:  `Ksh ${incrementalCredit.toLocaleString()} commission credit issued for ${property.name} (${month}) — a rent refund reduced what was actually owed`,
                meta:     { month, incrementalCredit, correctAmountDue, originallyPaid: paidRecord.amountDue },
                actor:    'system'
            });
        }

    } catch (err) {
        console.error('reconcileCommissionOverpayment error:', err.message);
    }
}

function monthIndexToLabel(monthNumber) {
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return monthNames[(monthNumber - 1 + 12) % 12];
}

const _MAX_DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInMonthOf(year, month1) { return new Date(year, month1, 0).getDate(); }

function _normalizeSemesterEntry(raw = {}, index = 0) {
  const clampInt = (v, min, max, def) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const isBlank = v => v === null || v === undefined || v === '';

  const rentOverride = isBlank(raw.rentAmount) ? null : Number(raw.rentAmount);
  return {
    label:      (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim().slice(0, 60) : `Semester ${index + 1}`,
    sequence:   index + 1,
    startMonth: clampInt(raw.startMonth, 1, 12, 1),
    startDay:   clampInt(raw.startDay, 1, 31, 1),
    endMonth:   clampInt(raw.endMonth, 1, 12, 6),
    endDay:     isBlank(raw.endDay) ? null : clampInt(raw.endDay, 1, 31, null),   // null = last day of the month
    rentAmount: (Number.isFinite(rentOverride) && rentOverride > 0) ? rentOverride : null,
    dueDay:     isBlank(raw.dueDay) ? null : clampInt(raw.dueDay, 1, 28, null)
  };
}

// Accepts the stored rule (legacy single-semester OR the new semesters[]) and
// always returns the same shape, so every existing caller keeps working.
function normalizeSemesterRule(rule = {}) {
  rule = rule || {};
  const enabled = !!rule.enabled;
  const legacyStart = Math.min(12, Math.max(1, Number(rule.startMonth) || 1));
  const legacyEnd   = Math.min(12, Math.max(1, Number(rule.endMonth) || 6));
  const rentAmountRaw = Number(rule.rentAmount);
  const rentAmount = Number.isFinite(rentAmountRaw) && rentAmountRaw >= 0 ? rentAmountRaw : 0;
  const dueDayRaw = Number(rule.dueDay);
  const dueDay = Number.isFinite(dueDayRaw) ? Math.min(28, Math.max(1, dueDayRaw)) : 5;
  const holdingRaw = Number(rule.holdingFee);
  const holdingFee = Number.isFinite(holdingRaw) && holdingRaw > 0 ? holdingRaw : 0;
  const gapPolicy = ['ask', 'auto', 'none'].includes(rule.gapPolicy) ? rule.gapPolicy : 'ask';

  const rawSemesters = Array.isArray(rule.semesters) ? rule.semesters.slice(0, 3) : [];
  const semesters = rawSemesters.length
    ? rawSemesters.map((s, i) => _normalizeSemesterEntry(s, i))
    // Legacy property (no semesters[] yet): behaves exactly as before — day 1 to last day of the end month
    : [_normalizeSemesterEntry({ label: 'Semester 1', startMonth: legacyStart, startDay: 1, endMonth: legacyEnd, endDay: null }, 0)];

  return {
    enabled,
    startMonth: semesters[0].startMonth,
    endMonth:   semesters[0].endMonth,
    rentAmount,
    dueDay,
    holdingFee,
    gapPolicy,
    expiryDate: null,
    semesters
  };
}
// Returns the canonical periodLabel for a house right now — the single
// source of truth every payment/billing lookup must use for semester tenants.
function getCurrentSemesterPeriodLabel(property, referenceDate = new Date()) {
    const rule = normalizeSemesterRule(property.semesterRule || {});
    const window = getSemesterWindow(rule, referenceDate.getFullYear());
    // e.g. "Sep 2026 – Jan 2027" — always the same string for the same window
    const startYear = window.startDate.getFullYear();
    const endYear   = window.endDate.getFullYear();
    return `${monthIndexToLabel(rule.startMonth)} ${startYear} – ${monthIndexToLabel(rule.endMonth)} ${endYear}`;
}

// Legacy signature kept: returns the FIRST semester's window for the given academic year.
function getSemesterWindow(rule = {}, year = new Date().getFullYear()) {
  return getAcademicYearWindows(rule, year)[0];
}

// Finds whichever semester window (this year, last year, or next year —
// covers wrap-around semesters like Sep–Jan) actually contains referenceDate.
// If referenceDate falls in a gap between semesters, picks the nearest
// upcoming window instead.
// Finds whichever semester (across last/this/next academic year) contains
// referenceDate. In a gap between semesters it picks the nearest UPCOMING one
// — the same behaviour the single-rule version had.
function getSemesterWindowContaining(rule, referenceDate = new Date()) {
    const safe = normalizeSemesterRule(rule);
    const y = referenceDate.getFullYear();
    const candidates = [];
    for (const ay of [y - 1, y, y + 1]) candidates.push(...getAcademicYearWindows(safe, ay));
    candidates.sort((a, b) => a.startDate - b.startDate);

    let match = candidates.find(w => referenceDate >= w.startDate && referenceDate <= w.endDate);
    if (!match) match = candidates.find(w => w.startDate > referenceDate) || candidates[candidates.length - 1];
    return match;
}

// ── Builds one semester's real dates for a given academic year. Semester 1
//    anchors the year; any later semester whose start falls "before" Semester 1
//    on the calendar (e.g. Sep–Dec then Jan–Apr) belongs to the following
//    calendar year automatically. ──
function _buildSemesterWindow(rule, semIndex, academicYear) {
    const sem   = rule.semesters[semIndex];
    const first = rule.semesters[0];
    const beforeFirst = semIndex > 0 && (
        sem.startMonth < first.startMonth ||
        (sem.startMonth === first.startMonth && sem.startDay < first.startDay)
    );
    const startYear = academicYear + (beforeFirst ? 1 : 0);

    const startDay = Math.min(sem.startDay, daysInMonthOf(startYear, sem.startMonth));
    const start    = new Date(startYear, sem.startMonth - 1, startDay, 0, 0, 0, 0);

    const resolveEndDay = y => sem.endDay ? Math.min(sem.endDay, daysInMonthOf(y, sem.endMonth)) : daysInMonthOf(y, sem.endMonth);
    let endYear = startYear;
    let endDay  = resolveEndDay(endYear);
    if (sem.endMonth < sem.startMonth || (sem.endMonth === sem.startMonth && endDay < startDay)) {
        endYear = startYear + 1;
        endDay  = resolveEndDay(endYear);
    }
    const end = new Date(endYear, sem.endMonth - 1, endDay, 23, 59, 59, 999);

    return {
        enabled:       rule.enabled,
        semesterIndex: semIndex,
        sequence:      semIndex + 1,
        semesterLabel: sem.label,
        academicYear,
        startMonth:    sem.startMonth,
        endMonth:      sem.endMonth,
        startDay,
        endDay,
        rentAmount:    sem.rentAmount || rule.rentAmount,   // per-semester override, else the default
        dueDay:        sem.dueDay     || rule.dueDay,
        startDate:     start,
        endDate:       end,
        expiryDate:    end,
        label:         `${monthIndexToLabel(sem.startMonth)}–${monthIndexToLabel(sem.endMonth)}`
    };
}

function getAcademicYearWindows(rule, academicYear) {
    const safe = normalizeSemesterRule(rule);
    return safe.semesters.map((_, i) => _buildSemesterWindow(safe, i, academicYear));
}

function academicYearLabel(windows) {
    const a = windows[0].startDate.getFullYear();
    const b = windows[windows.length - 1].endDate.getFullYear();
    return a === b ? String(a) : `${a}/${b}`;
}

// The academic year currently "in force": the latest one whose Semester 1 has
// started. After the last semester ends it stays the current year until the next
// Semester 1 begins — which is exactly the holiday window.
function getCurrentAcademicYear(rule, now = new Date()) {
    const safe = normalizeSemesterRule(rule);
    const y = now.getFullYear();
    const years = [y - 1, y, y + 1].map(ay => ({ ay, windows: getAcademicYearWindows(safe, ay) }));
    years.sort((a, b) => a.windows[0].startDate - b.windows[0].startDate);
    let current = years[0];
    for (const entry of years) if (entry.windows[0].startDate <= now) current = entry;
    return { ay: current.ay, windows: current.windows, label: academicYearLabel(current.windows) };
}

// Resolves a period label like "Jan 2026 – May 2026" back to its real window.
function findSemesterWindowByLabel(rule, label) {
    if (!label) return null;
    const safe = normalizeSemesterRule(rule);
    const y = new Date().getFullYear();
    for (let ay = y - 4; ay <= y + 2; ay++) {
        for (const w of getAcademicYearWindows(safe, ay)) {
            if (formatSemesterPeriodLabel(w) === label) return w;
        }
    }
    return null;
}

function getNextSemesterWindow(rule, window) {
    const safe = normalizeSemesterRule(rule);
    const list = [];
    for (const ay of [window.academicYear - 1, window.academicYear, window.academicYear + 1]) {
        list.push(...getAcademicYearWindows(safe, ay));
    }
    list.sort((a, b) => a.startDate - b.startDate);
    return list.find(w => w.startDate > window.startDate) || null;
}

// Inclusive day count of a semester (Jan 1 → May 24 = 144).
function semesterTotalDaysOf(window) {
    return Math.max(1, Math.round((window.endDate - window.startDate) / 86400000));
}

// Returns an error string, or null if the calendar is valid.
function validateSemesterConfig(rule) {
    const sems = rule.semesters;
    if (sems.length < 2 || sems.length > 3) return 'An academic year needs 2 or 3 semesters.';
    if (!(rule.rentAmount > 0)) return 'Enter a default semester rent amount greater than 0.';

    const seenStart = new Set();
    for (const s of sems) {
        if (s.startDay > _MAX_DAYS_IN_MONTH[s.startMonth]) return `${s.label}: the start month has no day ${s.startDay}.`;
        if (s.endDay && s.endDay > _MAX_DAYS_IN_MONTH[s.endMonth]) return `${s.label}: the end month has no day ${s.endDay}.`;
        if (seenStart.has(s.startMonth)) return 'Each semester must start in a different month.';
        seenStart.add(s.startMonth);
    }

    const windows = getAcademicYearWindows(rule, 2001);
    for (let i = 1; i < windows.length; i++) {
        if (windows[i].startDate <= windows[i - 1].endDate) {
            return `${sems[i].label} must start after ${sems[i - 1].label} ends — semesters cannot overlap or be out of order.`;
        }
    }
    const nextYearStart = getAcademicYearWindows(rule, 2002)[0].startDate;
    if (windows[windows.length - 1].endDate >= nextYearStart) {
        return 'The last semester runs into the first semester of the next academic year.';
    }
    return null;
}

function toStoredSemesterRule(rule) {
    return {
        enabled:    rule.enabled,
        startMonth: rule.semesters[0].startMonth,
        endMonth:   rule.semesters[0].endMonth,
        rentAmount: rule.rentAmount,
        dueDay:     rule.dueDay,
        holdingFee: rule.holdingFee,
        gapPolicy:  rule.gapPolicy,
        semesters:  rule.semesters.map(s => ({
            label: s.label, startMonth: s.startMonth, startDay: s.startDay,
            endMonth: s.endMonth, endDay: s.endDay, rentAmount: s.rentAmount, dueDay: s.dueDay
        })),
        expiryDate: rule.enabled ? getSemesterWindow(rule).expiryDate : null
    };
}

// Single entry point used by property create + update.
function buildSemesterRuleForSave(input) {
    const rule = normalizeSemesterRule(input || {});
    if (rule.enabled) {
        const err = validateSemesterConfig(rule);
        if (err) return { error: err };
    }
    return { rule: toStoredSemesterRule(rule) };
}


function formatSemesterPeriodLabel(window) {
    return `${monthIndexToLabel(window.startMonth)} ${window.startDate.getFullYear()} – ${monthIndexToLabel(window.endMonth)} ${window.endDate.getFullYear()}`;
}

// Due date is always day-X of the semester's LAST month — X comes from
// property.semesterRule.dueDay, carried through on `window` already.
function computeSemesterDueDate(window) {
    const dueDay = window.dueDay || 5;
    return new Date(window.endDate.getFullYear(), window.endMonth - 1, dueDay, 23, 59, 59, 999);
}

// The full proration + full-rent rule, in one place:
//  - window is always the one containing "now" (or the nearest upcoming one)
//  - assignedAt before window.startDate (early join, or a late-joiner whose
//    old semester already closed and got rolled into the next one) → clamps
//    to 0 elapsed days → full rent
//  - assignedAt <= 10 days into the window → full rent, no proration
//  - otherwise → ceil(dailyRate × remainingDays)
// Proration + full-rent rule, now per-semester:
//  - window = the semester containing "now" (or the nearest upcoming one)
//  - joined before the window started → full rent
//  - joined ≤ 10 days into the window → full rent
//  - otherwise ceil(dailyRate × remainingDays)
// options.lastReturnDate: a tenant back from a holiday is billed from the day
// they RETURNED (the holding fee already covered the time before that).
async function computeSemesterBillingSuggestion(tenant, property, now = new Date(), options = {}) {
    const rule = normalizeSemesterRule(property.semesterRule || {});
    if (!rule.enabled) return null;

    const window = getSemesterWindowContaining(rule, now);
    if (!(window.rentAmount > 0)) return null;

    let joinedAt = new Date(tenant.assignedAt || tenant.createdAt || now);
    if (options.lastReturnDate && new Date(options.lastReturnDate) > joinedAt) joinedAt = new Date(options.lastReturnDate);

    const totalDays = semesterTotalDaysOf(window);
    let daysElapsedAtJoin = Math.floor((joinedAt.getTime() - window.startDate.getTime()) / 86400000);
    if (daysElapsedAtJoin < 0) daysElapsedAtJoin = 0;
    if (daysElapsedAtJoin > totalDays) daysElapsedAtJoin = totalDays;

    const dailyRate = window.rentAmount / totalDays;
    const amountDue = daysElapsedAtJoin <= 10
        ? window.rentAmount
        : Math.ceil(dailyRate * (totalDays - daysElapsedAtJoin));

    return {
        periodLabel:   formatSemesterPeriodLabel(window),
        amountDue,
        dueDateActual: computeSemesterDueDate(window),
        semesterStart: window.startDate,
        semesterEnd:   window.endDate,
        rentAmount:    window.rentAmount,
        dailyRate,
        totalDays
    };
}

// ── Prorated refund suggestion for a mid-semester move-out — the exit-side
//    mirror of computeSemesterBillingSuggestion's join-side math. Whatever
//    portion of the CURRENT window remains unused gets a suggested refund,
//    capped at what was actually paid for that period so a refund can never
//    exceed money truly collected. ──
async function computeSemesterRefundSuggestion(tenant, property, now = new Date()) {
    const rule = normalizeSemesterRule(property.semesterRule || {});
    if (!rule.enabled) return null;

    const window      = getSemesterWindowContaining(rule, now);
    const periodLabel = formatSemesterPeriodLabel(window);

    // An extended stay lengthens the period (and its rent) — keep the daily rate consistent
    const billing = await Billing.findOne({
        landlord: tenant.landlord, tenant: tenant._id, house: tenant.house._id, periodLabel
    }).sort({ createdAt: -1 });
    const extensionDays = Number(billing?.extensionDays || 0);

    const semesterTotalDays = semesterTotalDaysOf(window) + extensionDays;
    let daysElapsed = Math.floor((now.getTime() - window.startDate.getTime()) / 86400000);
    if (daysElapsed < 0) daysElapsed = 0;
    if (daysElapsed > semesterTotalDays) daysElapsed = semesterTotalDays;
    const daysRemaining = semesterTotalDays - daysElapsed;

    const rent    = await getEffectiveRentForTenant(tenant, periodLabel);
    const summary = await getPeriodSummary(tenant._id, periodLabel, rent, 'semester');

    const dailyRate = rent / semesterTotalDays;
    let suggestedRefund = daysRemaining > 0 ? Math.ceil(dailyRate * daysRemaining) : 0;
    suggestedRefund = Math.min(suggestedRefund, summary.totalPaid);

    return {
        periodLabel,
        totalPaid:       summary.totalPaid,
        totalDue:        rent,
        daysRemaining,
        semesterEndDate: billing?.extendedEndDate || window.endDate,
        suggestedRefund
    };
}


// Canonical "what period is this tenant's balance measured against right
// now" — calendar month for monthly houses, live semester window for
// semester houses. Single source of truth reused by /arrears, /dashboard,
// and the upcoming-dues check.
async function getCurrentPeriodKeyForTenant(tenant, propertyCache = null) {
    if (!tenant.house) return null;
    const cycle = (tenant.house.billingCycle || 'monthly').toLowerCase();

    if (cycle === 'semester') {
        const property = propertyCache || await Property.findById(tenant.property).select('semesterRule');
        const rule = normalizeSemesterRule(property?.semesterRule || {});
        if (!rule.enabled) return null;
        // The semester the tenant is actually under (see getSemesterContext) — not simply "the next
        // one that starts" once a semester has ended.
        const ctx = await getSemesterContext(rule, tenant, new Date());
        return {
            key: formatSemesterPeriodLabel(ctx.window), cycle: 'semester', dueDateActual: computeSemesterDueDate(ctx.window),
            mode: ctx.mode, started: ctx.started, window: ctx.window, ctx
        };
    }
    // Monthly: anniversary cycle from the assignment date (or the legacy calendar month for tenants
    // that have no cycleAnchor yet) — see computeMonthlyCycle.
    const c = computeMonthlyCycle(tenant, new Date());
    return {
        key: c.key, cycle: 'monthly', dueDateActual: c.due,
        cycleStart: c.start, cycleEnd: c.end, mode: c.mode, isOverride: c.isOverride, prevKey: c.prevKey
    };
}

// ═══════════════════════════════════════
// MONTHLY RENT CYCLE (anniversary-based)
// ═══════════════════════════════════════
// A monthly tenant's rent cycle starts the day they are assigned a house (Tenant.cycleAnchor):
//   assigned 10 Oct  →  10 Oct–10 Nov, then 10 Nov–10 Dec, …   Rent is due at the END of a cycle.
// Period labels stay the existing "Month YYYY" strings, named after the month the cycle STARTS in, so
// every Payment.month, aggregate and receipt keeps working unchanged.
// A tenant with no cycleAnchor (created before this feature) stays on the legacy calendar-month
// logic: label = current calendar month, due on Tenant.dueDate (default the 5th).
// Everything is DERIVED on read and never stored, so the landlord's manual end date
// (Tenant.cycleEndOverride) can never be overwritten by a recalculation.

function monthLabelOf(date) {
    return new Date(date).toLocaleString('default', { month: 'long', year: 'numeric' });
}

// date + N months with the day clamped to the month length (31 Jan + 1 month = 28/29 Feb).
// Always computed from the anchor, never iteratively, so the day cannot drift (… 28 Feb → 31 Mar).
function addMonthsClamped(date, months) {
    const d   = new Date(date);
    const day = d.getDate();
    const out = new Date(d.getFullYear(), d.getMonth() + months, 1, 0, 0, 0, 0);
    out.setDate(Math.min(day, daysInMonthOf(out.getFullYear(), out.getMonth() + 1)));
    return out;
}

function monthIndexOfDate(d) { const x = new Date(d); return x.getFullYear() * 12 + x.getMonth(); }
// "October 2026" → year*12+month, or null when the label is not a monthly label (e.g. a semester label)
function monthIndexOfLabel(label) {
    const d = new Date('1 ' + String(label || ''));
    return isNaN(d.getTime()) ? null : monthIndexOfDate(d);
}

// → { mode: 'legacy'|'anniversary', key, start, end, due, originalEnd, isOverride, prevKey }
//   key         period label of the current cycle (named after the month it starts in)
//   start / end the cycle runs [start, end) — the next cycle starts ON `end`
//   due         when the rent for this cycle falls due (anniversary: = end; legacy: the due day)
//   originalEnd the automatic end date (differs from `end` only while a landlord override is active)
//   prevKey     label of the cycle that just ended (the only one that can be overdue), or null
function computeMonthlyCycle(tenant, now = new Date()) {
    const today     = startOfDay(now);
    const rawAnchor = tenant && tenant.cycleAnchor;

    // ── Legacy tenant: calendar month, due on Tenant.dueDate ──
    if (!rawAnchor) {
        const y = today.getFullYear(), m = today.getMonth();
        const start  = new Date(y, m, 1);
        const end    = new Date(y, m + 1, 1);
        const dueDay = Number(tenant && tenant.dueDate) || 5;
        const due    = new Date(y, m, Math.min(dueDay, daysInMonthOf(y, m + 1)));
        return { mode: 'legacy', key: monthLabelOf(start), start, end, due, originalEnd: end, isOverride: false, prevKey: null, prevStart: null, prevEnd: null };
    }

    const floor = startOfDay(tenant.assignedAt || tenant.createdAt || rawAnchor);   // the tenant was not here before this
    let anchor  = startOfDay(rawAnchor);
    let priorKeyAfterOverride   = null;
    let priorStartAfterOverride = null;

    // ── Landlord-adjusted cycle: runs until the chosen date; the NEXT cycle starts on that date ──
    const ov = tenant.cycleEndOverride;
    if (ov && ov.date && ov.cycleStart) {
        const ovEnd   = startOfDay(ov.date);
        const ovStart = startOfDay(ov.cycleStart);
        if (today < ovEnd) {
            const hasPrev = ovStart > floor;
            return {
                mode: 'anniversary', key: monthLabelOf(ovStart), start: ovStart, end: ovEnd, due: ovEnd,
                originalEnd: ov.originalEnd ? startOfDay(ov.originalEnd) : ovEnd,
                isOverride: true,
                prevKey:   hasPrev ? monthLabelOf(addMonthsClamped(ovStart, -1)) : null,
                prevStart: null,                       // exact start is not derivable here — emails omit the range
                prevEnd:   hasPrev ? ovStart : null    // the previous cycle ended exactly where this one began
            };
        }
        // The adjusted cycle is over → the series continues from the date the landlord set.
        anchor = ovEnd;
        priorKeyAfterOverride   = monthLabelOf(ovStart);
        priorStartAfterOverride = ovStart;
    }

    let k = (today.getFullYear() - anchor.getFullYear()) * 12 + (today.getMonth() - anchor.getMonth());
    if (k > 0 && addMonthsClamped(anchor, k) > today) k -= 1;
    if (k < 0) k = 0;

    const start = addMonthsClamped(anchor, k);
    const end   = addMonthsClamped(anchor, k + 1);
    let prevKey = null, prevStart = null, prevEnd = null;
    if (k >= 1) {
        prevKey   = monthLabelOf(addMonthsClamped(anchor, k - 1));
        prevStart = addMonthsClamped(anchor, k - 1);
        prevEnd   = start;
    } else if (priorKeyAfterOverride) {
        prevKey   = priorKeyAfterOverride;
        prevStart = priorStartAfterOverride;
        prevEnd   = anchor;
    }

    return { mode: 'anniversary', key: monthLabelOf(start), start, end, due: end, originalEnd: end, isOverride: false, prevKey, prevStart, prevEnd };
}

// Progress of a stay period. level: 'ok' (> 7 days left) · 'warn' (1–7 days left) · 'urgent' (due today or overdue)
function buildStayProgress(start, end, now = new Date()) {
    const s = startOfDay(start), e = startOfDay(end), t = startOfDay(now);
    const totalDays     = Math.max(1, dayDiff(e, s));
    const elapsedDays   = Math.min(totalDays, Math.max(0, dayDiff(t, s)));
    const daysRemaining = dayDiff(e, t);
    return {
        startISO: toISODate(s), endISO: toISODate(e),
        totalDays, elapsedDays, daysRemaining,
        percent: Math.round((elapsedDays / totalDays) * 100),
        level:   daysRemaining <= 0 ? 'urgent' : daysRemaining <= 7 ? 'warn' : 'ok'
    };
}

// Stay-progress data for the tenant profile (landlord side) and the tenant portal.
// Monthly → current rent cycle (honours the landlord's adjusted end date).
// Semester → the live semester window (honours an extended stay). null when there is nothing to show.
async function getStayProgressForTenant(tenant, propertyDoc = null, now = new Date()) {
    if (!tenant || tenant.status === 'moved_out' || !tenant.house) return null;
    const house = tenant.house;
    const cycle = String((house && house.billingCycle) || 'monthly').toLowerCase();

    if (cycle === 'semester') {
        const property = propertyDoc || await Property.findById(tenant.property).select('semesterRule');
        const rule = normalizeSemesterRule(property?.semesterRule || {});
        if (!rule.enabled) return null;
        const ctx = await getSemesterContext(rule, tenant, now);
        // Between semesters (or before the first one) there is no running period to measure progress of.
        if (ctx.mode === 'between' || ctx.mode === 'upcoming') return null;
        const window = ctx.window;
        const label  = formatSemesterPeriodLabel(window);
        const billing = await Billing.findOne({
            landlord: tenant.landlord, tenant: tenant._id, house: house._id, periodLabel: label
        }).sort({ createdAt: -1 });
        const end = billing?.extendedEndDate || window.endDate;
        return { cycle: 'semester', label, isOverride: !!billing?.extendedEndDate, ...buildStayProgress(window.startDate, end, now) };
    }

    const c = computeMonthlyCycle(tenant, now);
    return {
        cycle: 'monthly', label: c.key, mode: c.mode, isOverride: c.isOverride,
        originalEndISO: toISODate(c.originalEnd), ...buildStayProgress(c.start, c.end, now)
    };
}


// ═══════════════════════════════════════
// EMAIL PERIOD CONTEXT — billing-cycle details for rent emails
// ═══════════════════════════════════════
function formatEmailDate(d) {
    if (!d) return '';
    const x = new Date(d);
    if (isNaN(x.getTime())) return '';
    return `${x.getDate()} ${monthIndexToLabel(x.getMonth() + 1)} ${x.getFullYear()}`;
}

// "10 Oct – 10 Nov 2026" (same year) or "10 Dec 2026 – 10 Jan 2027" (spans two years)
function formatPeriodRange(start, end) {
    const s = new Date(start), e = new Date(end);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return '';
    if (s.getFullYear() === e.getFullYear()) {
        return `${s.getDate()} ${monthIndexToLabel(s.getMonth() + 1)} – ${e.getDate()} ${monthIndexToLabel(e.getMonth() + 1)} ${e.getFullYear()}`;
    }
    return `${formatEmailDate(s)} – ${formatEmailDate(e)}`;
}

// Everything the rent emails need about ONE tenant + ONE period label. `tenant.house` must be populated.
// Never throws, and never guesses: anything it cannot work out exactly is left empty, and the email
// simply omits that line.
//   cycle            'semester' | 'monthly' | undefined (no house → the email infers it from the label)
//   periodRange      "10 Oct – 10 Nov 2026" ('' = not shown)
//   dueDateText      "10 Nov 2026" ('' = fall back to the legacy due-day wording)
//   extensionCharge  extended-stay charge already inside the rent (semester only)
//   dueAt            the due date as a Date (used to decide "overdue" vs "due soon")
async function getEmailPeriodContext(tenant, periodLabel) {
    const out = { cycle: undefined, periodRange: '', dueDateText: '', extensionCharge: 0, dueAt: null };
    try {
        if (!tenant || !tenant.house || !periodLabel) return out;
        const house = tenant.house;
        const cycle = String(house.billingCycle || 'monthly').toLowerCase() === 'semester' ? 'semester' : 'monthly';
        out.cycle = cycle;

        if (cycle === 'semester') {
            const property = await Property.findById(tenant.property).select('semesterRule');
            const rule = normalizeSemesterRule(property?.semesterRule || {});
            if (!rule.enabled) return out;
            const w = findSemesterWindowByLabel(rule, periodLabel);
            if (!w) return out;

            const billing = await Billing.findOne({
                landlord: tenant.landlord, tenant: tenant._id, house: house._id, periodLabel
            }).sort({ createdAt: -1 });

            const end   = billing && billing.extendedEndDate ? billing.extendedEndDate : w.endDate;
            const dueAt = (billing && billing.dueDateActual) || computeSemesterDueDate(w);
            out.periodRange     = formatPeriodRange(w.startDate, end);
            out.dueAt           = dueAt;
            out.dueDateText     = formatEmailDate(dueAt);
            out.extensionCharge = Number(billing?.extensionCharge || 0);
            return out;
        }

        // Monthly
        const c = computeMonthlyCycle(tenant, new Date());
        if (periodLabel === c.key) {
            out.dueAt = c.due;
            if (c.mode === 'anniversary') {            // legacy tenants keep the due-day wording
                out.periodRange = formatPeriodRange(c.start, c.end);
                out.dueDateText = formatEmailDate(c.due);
            }
        } else if (c.mode === 'anniversary' && c.prevKey && periodLabel === c.prevKey && c.prevEnd) {
            out.dueAt       = c.prevEnd;
            out.dueDateText = formatEmailDate(c.prevEnd);
            if (c.prevStart) out.periodRange = formatPeriodRange(c.prevStart, c.prevEnd);
        }
    } catch (err) {
        console.error('getEmailPeriodContext failed:', err.message);
    }
    return out;
}

function getRequiredDepositAmount(property) {
    return Number(property?.depositPolicy?.depositAmount || 0);
}


function tenantHasValidDeposit(tenant, property) {
    return tenant.depositStatus === 'paid'
        && tenant.depositPaidForProperty
        && String(tenant.depositPaidForProperty) === String(property._id);
}

// ── Public referral codes ──
// Deliberately opaque and separate from the landlord's own _id — see the
// referralCode field comment in User.js for why. Excludes visually
// ambiguous characters (0/O, 1/I/L) since these end up read aloud or typed
// in manually off a phone screen.
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateReferralCode(name) {
    const lettersOnly = (name || '').replace(/[^a-zA-Z]/g, '');
    const prefix = lettersOnly.slice(0, 4) || 'REF';
    const prefixCased = prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();

    let suffix = '';
    for (let i = 0; i < 5; i++) {
        suffix += REFERRAL_CODE_ALPHABET[crypto.randomInt(REFERRAL_CODE_ALPHABET.length)];
    }
    return `${prefixCased}${suffix}`; // e.g. "Alex4X9QT"
}

// Lazy fetch-or-create, same pattern as getPlatformSettings(). Called from
// GET /landlord/referrals so every landlord — including ones who existed
// before this feature shipped — gets a code the first time they open the
// Refer & Earn modal, with no migration script needed.
//
// Two distinct failure modes, handled differently:
//  - E11000 on the write = a DIFFERENT landlord already holds this exact
//    random code (astronomically unlikely, but real) → generate a fresh
//    code and retry.
//  - matchedCount === 0 = THIS SAME landlord already got a code from a
//    concurrent request (e.g. two tabs open at once) between our read and
//    our write → don't generate a second, orphaned code; just read back and
//    return whichever one actually won.
// The `{ referralCode: { $exists: false } }` guard in the filter is what
// makes the write atomic and race-safe: only one concurrent call for the
// same landlord can ever match it and succeed.
async function getOrCreateReferralCode(landlordId) {
    const existing = await User.findById(landlordId).select('name referralCode');
    if (existing.referralCode) return existing.referralCode;

    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateReferralCode(existing.name);
        try {
            const result = await User.updateOne(
                { _id: landlordId, referralCode: { $exists: false } },
                { referralCode: code }
            );
            if (result.matchedCount === 1) return code;

            // Someone else already assigned this landlord a code in the
            // meantime — use it instead of racing further.
            const winner = await User.findById(landlordId).select('referralCode');
            if (winner.referralCode) return winner.referralCode;
            // else: exceedingly unlikely (would mean the field got unset
            // between our two reads) — fall through and try again.
        } catch (err) {
            if (err.code !== 11000) throw err; // a different landlord holds this code — retry with a new one
        }
    }
    throw new Error('Could not generate a unique referral code — please try again');
}

// ── Referral status is DERIVED, never stored — see ReferralReward.js header
//    note for why. 'scheduled' = reward earned but its month hasn't started
//    yet; 'active' = currently in its commission-free month; 'consumed' =
//    the month has closed. ──
function getReferralRewardStatus(reward) {
    const now = Date.now();
    if (now < new Date(reward.periodStart).getTime()) return 'scheduled';
    if (now <= new Date(reward.periodEnd).getTime())  return 'active';
    return 'consumed';
}

// ── Referral qualification check — call this from any event that could
//    flip a referred landlord's qualification criteria to true. Safe to
//    call redundantly/concurrently: it's a no-op once referralQualifiedAt is
//    set, and the atomic findOneAndUpdate guard below means two triggers
//    firing at once can't both "win" the transition or double-grant a reward.
async function checkReferralQualification(referredLandlordId) {
    try {
        const landlord = await User.findById(referredLandlordId).select('role referredBy referralQualifiedAt');
        if (!landlord || landlord.role !== 'landlord' || !landlord.referredBy || landlord.referralQualifiedAt) {
            return; // not a referred landlord, or already qualified — nothing to do
        }

        const settings = await getPlatformSettings();
        const rules = settings.referralQualificationRules || {
            newLandlord: true, propertySetupCompleted: true, firstPaymentProcessed: true
        };

        // "New landlord" is inherently satisfied by reaching this point at
        // all — referredBy is only ever set once, at registration, so there's
        // nothing further to check for that rule.

        if (rules.propertySetupCompleted) {
            const setupDone = await Property.exists({ landlord: referredLandlordId, paymentConfigured: true });
            if (!setupDone) return;
        }

        if (rules.firstPaymentProcessed) {
            // FIX: a deposit-only record shouldn't count as "processed a first payment" for referral qualification
            const paid = await Payment.exists({ landlord: referredLandlordId, category: 'rent', status: { $in: ['paid', 'partial'] } });
            if (!paid) return;
        }

        // Atomic claim of the qualification transition.
        const claimed = await User.findOneAndUpdate(
            { _id: referredLandlordId, referralQualifiedAt: null },
            { referralQualifiedAt: new Date() }
        );
        if (!claimed) return; // another concurrent trigger already claimed it

        logActivity({
            landlord: landlord.referredBy,
            action:   'referral.qualified',
            message:  `A landlord you referred is now a qualified referral 🎉`,
            meta:     { referredLandlordId }
        });

        await maybeGrantReferralReward(landlord.referredBy);

    } catch (err) {
        console.error('checkReferralQualification error:', err.message);
    }
}

// ── Grants the ONE lifetime referral reward, if this landlord has just
//    crossed the required qualified-referral count and doesn't already have
//    one. The real enforcement of "only ever 1, no matter how many you
//    refer" is the unique index on ReferralReward.landlord (see that model's
//    header note) — the existence check below is just a fast, cheap
//    short-circuit to avoid unnecessary work, not the source of truth. ──
async function maybeGrantReferralReward(referrerId) {
    const existing = await ReferralReward.findOne({ landlord: referrerId }).select('_id').lean();
    if (existing) return;

    const settings = await getPlatformSettings();
    const required  = settings.referralRequiredCount || 5;

    const qualified = await User.find({ referredBy: referrerId, referralQualifiedAt: { $ne: null } })
        .select('_id')
        .sort({ referralQualifiedAt: 1 }) // earliest-qualified first — this is the credited set if there are more than `required`
        .limit(required)
        .lean();

    if (qualified.length < required) return;

    const monthLabel  = getMonthLabel(1); // always a full, upcoming calendar month — never the partial current one
    const monthDate   = new Date(monthLabel);
    const periodStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 0, 0, 0, 0);
    const periodEnd   = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59, 999);

    try {
        const reward = await ReferralReward.create({
            landlord:             referrerId,
            qualifyingReferrals:  qualified.map(q => q._id),
            requiredCountAtGrant: required,
            month:                monthLabel,
            periodStart,
            periodEnd
        });

        logActivity({
            landlord: referrerId,
            action:   'referral.reward_earned',
            message:  `🎉 Referral reward unlocked — commission-free for ${monthLabel}`,
            meta:     { rewardId: reward._id, month: monthLabel, qualifyingReferrals: reward.qualifyingReferrals }
        });

    } catch (err) {
        // E11000 = duplicate key on the unique `landlord` index — a concurrent
        // call already granted the (one and only) reward. Not an error.
        if (err.code !== 11000) {
            console.error('maybeGrantReferralReward error:', err.message);
        }
    }
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

// ── Caretaker role gates ──
function caretakerOnly(req, res, next) {
    if (req.user.role !== 'caretaker') {
        return res.status(403).json({ message: 'Caretakers only' });
    }
    next();
}

function landlordOrCaretaker(req, res, next) {
    if (req.user.role !== 'landlord' && req.user.role !== 'caretaker') {
        return res.status(403).json({ message: 'Access denied' });
    }
    next();
}

// ── Resolves the effective "landlord scope" for a request — for a landlord
// this is just their own id; for a caretaker it's the landlordId they work
// under. Every shared route should call this instead of hardcoding
// req.user.id, so the branching logic lives in one place. ──
async function resolveLandlordScope(req) {
    if (req.user.role === 'landlord')  return req.user.id;
    if (req.user.role === 'caretaker') return req.user.landlordId;
    return null;
}

// ── Caretaker-specific property gate — checks the property belongs to their
// employer AND is in their assigned properties list. Landlords bypass this
// entirely (their existing Property.findOne({..., landlord: req.user.id})
// checks in each route already enforce ownership). ──
async function checkCaretakerPropertyAccess(req, res, next) {
    if (req.user.role !== 'caretaker') return next();

    const propertyId = req.body.propertyId || req.params.propertyId || req.query.propertyId;
    if (!propertyId) return next();

    try {
        const caretaker = await User.findById(req.user.id).select('properties');
        if (!caretaker) return res.status(404).json({ message: 'Caretaker not found' });

        const assigned = (caretaker.properties || []).map(String).includes(String(propertyId));
        if (!assigned) {
            return res.status(403).json({ message: 'You are not assigned to this property' });
        }
        next();
    } catch (err) {
        console.error('checkCaretakerPropertyAccess error:', err.message);
        res.status(500).json({ message: 'Server error' });
    }
}

// ── FIX (plans → commission migration): replaces checkSubscription.
// The platform is free forever now, so this ONLY checks the moderation
// suspend switch — no more trial/grace/expired billing lifecycle. ──
// FIX: previously only checked req.user.role === 'landlord', so if a
// landlord's account got suspended, every caretaker they'd created kept
// full access through every landlordOrCaretaker route (payments, tenants,
// messages, announcements, maintenance, etc.) — suspension only blocked
// the landlord's own login, not their staff. Now resolves the effective
// landlord scope for BOTH roles and checks that account's status, so a
// suspended landlord's caretakers are locked out at the same moment the
// landlord is.
async function checkAccountStatus(req, res, next) {
    if (req.user.role !== 'landlord' && req.user.role !== 'caretaker') return next();

    try {
        const landlordScope = await resolveLandlordScope(req);
        if (!landlordScope) return res.status(403).json({ message: 'Access denied' });

        const landlord = await User.findById(landlordScope).select('accountStatus suspendedReason');
        if (!landlord) return res.status(404).json({ message: 'Landlord not found' });

        if (landlord.accountStatus === 'suspended') {
            return res.status(403).json({
                message: req.user.role === 'caretaker'
                    ? `This account has been suspended. Reason: ${landlord.suspendedReason || 'Contact support.'}`
                    : `Your account has been suspended. Reason: ${landlord.suspendedReason || 'Contact support.'}`,
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
// FIX: previously scoped to req.user.id directly, which only works for
// landlords. A caretaker's id is never a property's `landlord` field, so
// the lookup always missed and the check silently passed through
// (fail-open) rather than blocking. Not currently exploitable — every
// route this middleware guards is landlordOnly — but fixing the scope
// resolution here means it stays correct if a route's access level ever
// changes, instead of silently reopening this gap.
async function checkPropertySuspension(req, res, next) {
    try {
        const propertyId = req.body.propertyId || req.params.propertyId || req.query.propertyId;
        if (!propertyId) return next();

        const landlordScope = await resolveLandlordScope(req);
        if (!landlordScope) return next(); // let the route's own auth checks handle it

        const property = await Property.findOne({ _id: propertyId, landlord: landlordScope })
            .select('isSuspended suspendedReason name');

        if (property && property.isSuspended) {
            return res.status(403).json({
                message: `${property.name} is suspended — ${property.suspendedReason || 'unpaid commission'}. ${
                    req.user.role === 'caretaker'
                        ? 'Contact your landlord to resolve this.'
                        : 'Settle the balance from the Commission panel to restore access.'
                }`,
                code: 'PROPERTY_SUSPENDED'
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

// ── Public: resolve a referral code to a display name ──
// No auth — called from auth.html the moment a ?ref= link is opened, so the
// register form can show "Referred by <name>" instead of the raw code.
// Returns first name only; never the landlord's email, id, or full profile.
app.get('/public/referral-info/:code', async (req, res) => {
    try {
        const code = sanitize(req.params.code || '', 40);
        if (!code) return res.status(400).json({ message: 'Referral code required' });

        const landlord = await User.findOne({ referralCode: code, role: 'landlord' }).select('name');
        if (!landlord) return res.status(404).json({ message: 'Invalid referral code' });

        res.json({ name: (landlord.name || '').split(' ')[0] || 'a fellow landlord' });

    } catch (err) {
        console.error('GET /public/referral-info error:', err.message);
        res.status(500).json({ message: 'Failed to resolve referral code' });
    }
});

// AFTER:
app.post('/landlord/register', async (req, res) => {
    try {
        // FIX Bug 22: sanitize all inputs
        const name             = sanitize(req.body.name || '');
        const email            = sanitize(req.body.email || '').toLowerCase();
        const password         = req.body.password || '';
        const phone            = sanitize(req.body.phone || '');
        const propertyName     = sanitize(req.body.propertyName || '');
        const propertyLocation = sanitize(req.body.propertyLocation || '');

        // Referral attribution — an opaque referralCode passed via ?ref= on
        // the signup link (never the landlord's own _id — see the
        // referralCode field comment in User.js for why). Validated as a
        // real, existing landlord; silently ignored (never blocks signup)
        // if missing or bogus.
        let referredBy = null;
        const refParam = sanitize(req.body.ref || '', 40);
        if (refParam) {
            const refLandlord = await User.findOne({ referralCode: refParam, role: 'landlord' }).select('_id');
            if (refLandlord) referredBy = refLandlord._id;
        }
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
        // AFTER:
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
            termsVersion:       process.env.TERMS_VERSION || '1.0',
            ...(referredBy && { referredBy })
        });

        if (referredBy) {
            logActivity({
                landlord: referredBy,
                action:   'referral.signup',
                message:  `${name} signed up using your referral link`,
                meta:     { referredLandlordId: landlord._id }
            });
        }

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

         if ((user.role === 'tenant' || user.role === 'caretaker') && user.mustChangePassword) {
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

        // ── Caretaker: return only their assigned properties + who they
        // work for, so the frontend never needs a second round-trip just
        // to render the property switcher or know which UI to hide. ──
        if (user.role === 'caretaker') {
            const landlordUser = await User.findById(user.landlordId).select('name propertyName');
            const properties   = await Property.find({ _id: { $in: user.properties || [] } })
                .select('name location paymentConfigured isActive')
                .sort({ createdAt: 1 });

            response.caretaker = {
                id:    user._id,
                name:  user.name,
                email: user.email,
                phone: user.phone
            };
            response.landlord = {
                id:   user.landlordId,
                name: landlordUser?.name || '—'
            };
            response.properties  = properties;
            response.permissions = user.caretakerPermissions;
        }

        res.json(response);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/force-change-password', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant' && req.user.role !== 'caretaker') {
            return res.status(403).json({ message: 'Tenants and caretakers only' });
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

app.get('/landlord/profile', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        // ── Caretaker: scoped equivalent response. No mpesa/subscription/
        // accountStatus fields — those are landlord-account concepts a
        // caretaker has no ownership of. Their own name/email comes from
        // their own User doc; "who they work for" comes from landlordId. ──
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('name email phone landlordId properties');
            if (!caretaker) return res.status(404).json({ message: 'Caretaker not found' });

            const landlordUser = await User.findById(caretaker.landlordId).select('accountStatus suspendedReason');

            const properties = await Property.find({ _id: { $in: caretaker.properties || [] } })
                .select('name location phone paymentConfigured isActive isSuspended suspendedReason')
                .sort({ createdAt: 1 });

            return res.json({
                id:                 caretaker._id,
                name:               caretaker.name,
                email:              caretaker.email,
                phone:              caretaker.phone,
                onboardingComplete: true,   // caretakers never go through onboarding
                paymentConfigured:  properties.some(p => p.paymentConfigured),
                accountStatus:      landlordUser?.accountStatus || 'active', // reflects employer's account, not their own
                properties
            });
        }

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


// ── Referral program: this landlord's link + who they've referred so far.
// "active" here means the referred landlord has at least one property with
// paymentConfigured — a real signal of engagement, not just an empty account.
app.get('/landlord/referrals', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const referred = await User.find({ referredBy: req.user.id, role: 'landlord' })
            .select('name createdAt referralQualifiedAt')
            .sort({ createdAt: -1 });

        // Kept for backward compatibility with anything already reading
        // "active" — it means the same thing it always did (payment
        // credentials configured), and is NOT the same thing as "qualified"
        // (which also requires a first processed payment, per the current
        // referral rules).
        const referredIds = referred.map(r => r._id);
        const activeIds = referredIds.length
            ? (await Property.find({ landlord: { $in: referredIds }, paymentConfigured: true }).distinct('landlord'))
            : [];
        const activeSet = new Set(activeIds.map(String));

        const settings      = await getPlatformSettings();
        const requiredCount = settings.referralRequiredCount || 5;
        const qualifiedCount = referred.filter(r => !!r.referralQualifiedAt).length;

        const rewardDoc = await ReferralReward.findOne({ landlord: req.user.id }).lean();
        const reward = rewardDoc ? {
            status:      getReferralRewardStatus(rewardDoc),
            month:       rewardDoc.month,
            periodStart: rewardDoc.periodStart,
            periodEnd:   rewardDoc.periodEnd,
            earnedAt:    rewardDoc.earnedAt
        } : null;

        const referralCode = await getOrCreateReferralCode(req.user.id);

        res.json({
            landlordId: req.user.id,
            referralCode,
            totalReferred:  referred.length,
            activeReferred: activeSet.size,
            requiredCount,
            qualifiedCount,
            // Reward is a lifetime one-shot — once it's been earned, the
            // progress bar has nothing left to track even if more referrals
            // come in, so we cap this at 100% rather than showing >100%.
            progressPercent: reward ? 100 : Math.min(100, Math.round((qualifiedCount / requiredCount) * 100)),
            reward,
            referrals: referred.map(r => ({
                name:       r.name,
                joinedAt:   r.createdAt,
                active:     activeSet.has(String(r._id)),
                qualified:  !!r.referralQualifiedAt,
                qualifiedAt: r.referralQualifiedAt || null
            }))
        });
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

    const { paybillNumber, consumerKey, consumerSecret, passkey, propertyId, otp, accountType } = req.body;
    const finalAccountType = accountType === 'till' ? 'till' : 'paybill'; // default safe

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
                property.mpesaAccountType    = finalAccountType;
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

                // Fire-and-forget — never let a referral check delay the response.
                checkReferralQualification(req.user.id)
                    .catch(err => console.error('Referral qualification check failed:', err.message));

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


// ── "Adjust amount" for a semester tenant's CURRENT period ──
//    • The landlord edits the BASE rent. Any extension charge already on the period is kept on top of it,
//      so an adjustment can never silently erase it (or double-count it).
//    • It only ever updates the period the tenant is under — it cannot create a new period or an arrear
//      for another one — and it never touches what has been paid: paid / balance / status are always
//      worked out from the real payments, so they are not stored (and not reset) here.
//    • The house is the tenant's own house, taken from the server, never from the request.
//    • Monthly rent is changed on the house itself (it then applies from the next rent cycle).
app.post('/landlord/billing', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenantId     = sanitize(req.body.tenantId || '');
        const billingCycle = (req.body.billingCycle || 'semester').toLowerCase();
        const baseAmount   = Number(req.body.baseAmount !== undefined ? req.body.baseAmount : req.body.amountDue);

        if (!/^[a-f0-9]{24}$/i.test(tenantId)) return res.status(400).json({ message: 'tenantId is required' });
        if (billingCycle !== 'semester') {
            return res.status(400).json({ message: 'Monthly rent is changed on the house itself, and applies from the next rent cycle. Only semester periods are adjusted here.' });
        }
        if (!Number.isFinite(baseAmount) || baseAmount < 0) {
            return res.status(400).json({ message: 'The amount must be a valid non-negative number' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id, status: 'active' }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Active tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'This tenant has no house yet' });
        const house = tenant.house;
        if ((house.billingCycle || 'monthly') !== 'semester') {
            return res.status(400).json({ message: "This tenant's house is not billed per semester" });
        }

        const property = await Property.findOne({ _id: tenant.property, landlord: req.user.id }).select('semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });
        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.status(400).json({ message: 'Semester billing is not enabled for this property' });

        // The period the tenant is under (server-authoritative) — during a break that is the semester that just ended.
        const ctx         = await getSemesterContext(rule, tenant, new Date());
        const window      = ctx.window;
        const periodLabel = formatSemesterPeriodLabel(window);

        const existing        = await Billing.findOne({ landlord: req.user.id, tenant: tenant._id, house: house._id, periodLabel }).sort({ createdAt: -1 });
        const extensionCharge = Number(existing?.extensionCharge || 0);
        const newTotal        = baseAmount + extensionCharge;
        const previousTotal   = existing && existing.amountDue > 0 ? existing.amountDue : window.rentAmount;

        const billing = await Billing.findOneAndUpdate(
            { landlord: req.user.id, property: tenant.property, tenant: tenant._id, house: house._id, periodLabel },
            {
                $set:         { billingCycle: 'semester', amountDue: newTotal },
                $setOnInsert: { dueDate: window.dueDay, dueDateActual: computeSemesterDueDate(window), status: 'unpaid', paidAmount: 0 }
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        const summary = await getPeriodSummary(tenant._id, periodLabel, newTotal, 'semester');
        logActivity({
            landlord: req.user.id, property: tenant.property,
            action:   'billing.adjusted',
            message:  `${tenant.name}: ${periodLabel} rent set to Ksh ${baseAmount.toLocaleString()}${extensionCharge ? ` + Ksh ${extensionCharge.toLocaleString()} extension` : ''} (was Ksh ${Number(previousTotal).toLocaleString()} in total)`,
            meta:     { tenantId: tenant._id, periodLabel, baseAmount, extensionCharge, previousTotal }
        });

        res.json({
            message: 'Billing saved successfully', billing,
            period: {
                periodLabel, baseAmount, extensionCharge, totalDue: newTotal,
                paid: summary.totalPaid, balance: summary.balance, status: summary.status,
                overpaid: Math.max(0, summary.totalPaid - newTotal)
            }
        });

    } catch (err) {
        console.error('landlord billing error:', err.message);
        res.status(500).json({ message: err.message });
    }
});


app.get('/landlord/billing/:tenantId', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenant = await Tenant.findOne({
            _id: req.params.tenantId,
            landlord: req.user.id
        });

        if (!tenant) {
            return res.status(404).json({ message: 'Tenant not found' });
        }

        const bills = await Billing.find({
            landlord: req.user.id,
            tenant: tenant._id,
            property: tenant.property
        }).sort({ createdAt: -1 });

        // paid / balance / status are NEVER read from the stored fields (nothing keeps them in sync with
        // payments) — every row is worked out from the real payment records, exactly like the profile header.
        const full     = await Tenant.findById(tenant._id).populate('house');
        const property = await Property.findById(tenant.property).select('semesterRule');
        const rule     = normalizeSemesterRule(property?.semesterRule || {});
        const now      = new Date();

        const labels = new Set(bills.map(b => b.periodLabel));
        if (full && full.house && (full.house.billingCycle || 'monthly') === 'semester' && rule.enabled) {
            const payLabels = await Payment.distinct('periodLabel', { tenant: tenant._id, category: 'rent' });
            payLabels.filter(Boolean).forEach(l => labels.add(l));
            if (full.status === 'active') labels.add(formatSemesterPeriodLabel((await getSemesterContext(rule, full, now)).window));
        }

        const periods = [];
        for (const label of labels) {
            const w = rule.enabled ? findSemesterWindowByLabel(rule, label) : null;
            if (!w) continue;                                          // not a semester period label
            const bill   = bills.find(b => b.periodLabel === label) || null;
            const total  = await getEffectiveRentForTenant(full, label);
            const sum    = await getPeriodSummary(tenant._id, label, total, 'semester');
            const extCh  = Number(bill?.extensionCharge || 0);
            periods.push({
                periodLabel: label, semesterLabel: w.semesterLabel,
                startISO: toISODate(w.startDate), endISO: toISODate(w.endDate),
                dueISO: toISODate(bill?.dueDateActual || computeSemesterDueDate(w)),
                amountDue: total, baseAmount: Math.max(0, total - extCh), extensionCharge: extCh,
                paid: sum.totalPaid, balance: sum.balance, status: sum.status,
                started: w.startDate <= now, hasRecord: !!bill, _sort: w.startDate.getTime()
            });
        }
        periods.sort((a, b) => b._sort - a._sort).forEach(p => delete p._sort);

        const computedBills = bills.map(b => {
            const o = b.toObject();
            const p = periods.find(x => x.periodLabel === b.periodLabel);
            return p ? { ...o, paidAmount: p.paid, balance: p.balance, status: p.status, baseAmount: p.baseAmount } : o;
        });

        res.json({ tenantId: tenant._id, bills: computedBills, periods });
    } catch (err) {
        console.error('get landlord billing error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

app.get('/landlord/billing/:tenantId/current-period', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: landlordScope }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house assigned' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(tenant.property));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        if ((tenant.house.billingCycle || 'monthly') !== 'semester') {
            // Opt-in only (?monthly=1) so existing semester-only callers behave exactly as before.
            if (req.query.monthly === '1') {
                const mc = computeMonthlyCycle(tenant, new Date());
                return res.json({
                    cycle: 'monthly', periodLabel: mc.key, dueDateActual: mc.due,
                    startISO: toISODate(mc.start), endISO: toISODate(mc.end)
                });
            }
            return res.status(400).json({ message: 'This tenant is not on semester billing' });
        }

        const property = await Property.findOne({ _id: tenant.property, landlord: landlordScope }).select('semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const lastHold = await HolidayHold.findOne({ tenant: tenant._id, status: 'returned' })
            .sort({ actualReturnDate: -1 }).select('actualReturnDate').lean();

        // The period the tenant is under (during a break: the semester that just ended), not "the next one".
        const rule = normalizeSemesterRule(property.semesterRule || {});
        const ctx  = rule.enabled ? await getSemesterContext(rule, tenant, new Date()) : null;
        const suggestion = await computeSemesterBillingSuggestion(tenant, property, ctx ? ctx.window.startDate : new Date(), {
            lastReturnDate: lastHold?.actualReturnDate || null
        });
        if (!suggestion) {
            return res.status(400).json({ message: 'Semester billing is not configured for this property yet' });
        }

        const existingBilling = await Billing.findOne({
            landlord: landlordScope, tenant: tenant._id, house: tenant.house._id, periodLabel: suggestion.periodLabel
        }).sort({ createdAt: -1 });

        // What the system charges right now, and how much of it is already paid — so the landlord sees
        // the effect of a change BEFORE saving it.
        const totalNow        = await getEffectiveRentForTenant(tenant, suggestion.periodLabel);
        const extensionCharge = Number(existingBilling?.extensionCharge || 0);
        const sum             = await getPeriodSummary(tenant._id, suggestion.periodLabel, totalNow, 'semester');

        res.json({
            periodLabel:        suggestion.periodLabel,
            suggestedAmountDue: suggestion.amountDue,
            amountDue:          existingBilling ? existingBilling.amountDue : suggestion.amountDue,
            dueDateActual:      existingBilling ? existingBilling.dueDateActual : suggestion.dueDateActual,
            hasExistingBilling: !!existingBilling,
            // new — everything the "Adjust amount" dialog shows
            periodMode:         ctx ? ctx.mode : 'in',
            semesterLabel:      ctx ? ctx.window.semesterLabel : null,
            baseAmount:         Math.max(0, totalNow - extensionCharge),
            suggestedBaseAmount: suggestion.amountDue,
            extensionCharge,
            totalDue:           totalNow,
            paid:               sum.totalPaid,
            balance:            sum.balance
        });

    } catch (err) {
        console.error('GET current-period error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ═══════════════════════════════════════
// CARETAKERS
// ═══════════════════════════════════════
//
// A caretaker is a landlord-created helper account, scoped to a subset of
// the landlord's properties. Reuses User.landlordId (already used for
// tenants) to mean "who this account works for" — role: 'caretaker'
// disambiguates it from a tenant using the same field.

// ── Landlord: create a caretaker account ──
app.post('/landlord/caretakers/create', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const name        = sanitize(req.body.name  || '');
        const email       = sanitize(req.body.email || '').toLowerCase();
        const phone       = sanitize(req.body.phone || '');
        const propertyIds = Array.isArray(req.body.propertyIds) ? req.body.propertyIds : [];

        if (!name || !email || !phone) {
            return res.status(400).json({ message: 'name, email and phone are required' });
        }
        if (!propertyIds.length) {
            return res.status(400).json({ message: 'Assign at least one property' });
        }

        // Verify all propertyIds actually belong to this landlord
        const owned = await Property.find({ _id: { $in: propertyIds }, landlord: req.user.id }).select('_id');
        if (owned.length !== propertyIds.length) {
            return res.status(400).json({ message: 'One or more properties do not belong to you' });
        }

        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ message: 'An account with this email already exists' });

        const tempPassword   = crypto.randomBytes(6).toString('base64').slice(0, 8);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        const landlordUser = await User.findById(req.user.id).select('name');

        // Only accept known permission keys, whitelisted — never trust an
        // arbitrary object shape from the client into a schema subdocument.
        const allowedPermKeys = ['canRecordPayments', 'canManageMaintenance', 'canMessageTenants', 'canPostAnnouncements', 'canManageTenants'];
        const caretakerPermissions = {};
        if (req.body.permissions && typeof req.body.permissions === 'object') {
            for (const key of allowedPermKeys) {
                if (typeof req.body.permissions[key] === 'boolean') {
                    caretakerPermissions[key] = req.body.permissions[key];
                }
            }
        }

        const caretaker = await User.create({
            name, email, phone,
            password:             hashedPassword,
            role:                  'caretaker',
            landlordId:            req.user.id,
            properties:            propertyIds,
            mustChangePassword:    true,
            ...(Object.keys(caretakerPermissions).length && { caretakerPermissions })
        });

        // NOTE: requires sendCaretakerWelcomeEmail to be added to emails.js
        // (mirrors sendTenantWelcomeEmail's shape) and imported at the top
        // of this file before this route will send mail successfully.
        if (typeof sendCaretakerWelcomeEmail === 'function') {
            sendCaretakerWelcomeEmail({
                name, email, tempPassword,
                landlordName: landlordUser?.name || 'Your landlord'
            }).catch(err => console.error('Caretaker welcome email failed:', err.message));
        }

        logActivity({
            landlord: req.user.id,
            action:   'caretaker.created',
            message:  `${name} added as caretaker for ${owned.length} propert${owned.length === 1 ? 'y' : 'ies'}`,
            meta:     { caretakerId: caretaker._id, propertyIds }
        });

        res.status(201).json({
            message:   'Caretaker created — welcome email sent ✅',
            caretaker: { id: caretaker._id, name, email, phone, properties: propertyIds }
        });

    } catch (err) {
        console.error('Create caretaker error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Landlord: list their caretakers ──
app.get('/landlord/caretakers', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const caretakers = await User.find({ landlordId: req.user.id, role: 'caretaker' })
            .select('-password')
            .populate('properties', 'name location')
            .sort({ createdAt: 1 });
        res.json({ caretakers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Landlord: update a caretaker's assigned properties / permissions ──
app.put('/landlord/caretakers/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const caretaker = await User.findOne({ _id: req.params.id, landlordId: req.user.id, role: 'caretaker' });
        if (!caretaker) return res.status(404).json({ message: 'Caretaker not found' });

        if (Array.isArray(req.body.propertyIds)) {
            const owned = await Property.find({ _id: { $in: req.body.propertyIds }, landlord: req.user.id }).select('_id');
            if (owned.length !== req.body.propertyIds.length) {
                return res.status(400).json({ message: 'One or more properties do not belong to you' });
            }
            caretaker.properties = req.body.propertyIds;
        }

        if (req.body.permissions && typeof req.body.permissions === 'object') {
            const allowedKeys = ['canRecordPayments', 'canManageMaintenance', 'canMessageTenants', 'canPostAnnouncements'];
            for (const key of allowedKeys) {
                if (typeof req.body.permissions[key] === 'boolean') {
                    caretaker.caretakerPermissions[key] = req.body.permissions[key];
                }
            }
        }

        await caretaker.save();
        res.json({ message: 'Caretaker updated ✅', caretaker });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Landlord: revoke a caretaker's access entirely ──
app.delete('/landlord/caretakers/:id', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const caretaker = await User.findOneAndDelete({ _id: req.params.id, landlordId: req.user.id, role: 'caretaker' });
        if (!caretaker) return res.status(404).json({ message: 'Caretaker not found' });

        logActivity({
            landlord: req.user.id,
            action:   'caretaker.revoked',
            message:  `${caretaker.name}'s caretaker access was revoked`,
            meta:     { caretakerId: caretaker._id }
        });

        res.json({ message: 'Caretaker access revoked ✅' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// ── Caretaker: fetch my own current permissions + assigned properties.
// Called on every dashboard load (and periodically) so a landlord editing
// permissions takes effect without forcing the caretaker to log out. ──
app.get('/caretaker/me', authMiddleware, caretakerOnly, async (req, res) => {
    try {
        const caretaker = await User.findById(req.user.id).select('properties caretakerPermissions landlordId');
        if (!caretaker) return res.status(404).json({ message: 'Caretaker not found' });

        const properties = await Property.find({ _id: { $in: caretaker.properties || [] } })
            .select('name location paymentConfigured isActive');

        const landlordUser = await User.findById(caretaker.landlordId).select('name');

        res.json({
            permissions: caretaker.caretakerPermissions,
            properties,
            landlord: { name: landlordUser?.name || '—' }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
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

        const builtRule = buildSemesterRuleForSave(req.body.semesterRule || {});
        if (builtRule.error) return res.status(400).json({ message: builtRule.error });
        const minPercentInput = Number(req.body.depositPolicy?.minimumDepositPercent);
       const policy = {
            requireDepositBeforeAssignment: req.body.depositPolicy?.requireDepositBeforeAssignment !== false,
            depositAmount: Math.max(0, Number(req.body.depositPolicy?.depositAmount) || 0)
        };

        const property = await Property.create({
            landlord: req.user.id,
            name,
            location: location || null,
            phone:    phone    || null,
            semesterRule: builtRule.rule,
            depositPolicy: policy
        });

        res.status(201).json({ message: 'Property created ✅', property });

    } catch (err) {
        console.error('Create property error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/properties', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope };

        // Caretakers only ever see their own assigned subset
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            query._id = { $in: caretaker.properties || [] };
        }

        const properties = await Property.find(query).sort({ createdAt: 1 });
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
        const name     = sanitize(req.body.name     || '');
        const location = sanitize(req.body.location || '');
        const phone    = sanitize(req.body.phone    || '');

        const property = await Property.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (name)     property.name     = name;
        if (location) property.location = location;
        if (phone)    property.phone    = phone;

        if (req.body.semesterRule) {
            const built = buildSemesterRuleForSave(req.body.semesterRule);
            if (built.error) return res.status(400).json({ message: built.error });
            property.semesterRule = built.rule;
        }

        // Default holiday holding fee for monthly tenants (Ksh per month)
        if (req.body.monthlyHoldingFee !== undefined && req.body.monthlyHoldingFee !== null && req.body.monthlyHoldingFee !== '') {
            const fee = Number(req.body.monthlyHoldingFee);
            if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ message: 'Holding fee must be 0 or more' });
            property.monthlyHoldingFee = fee;
        }

        if (req.body.depositPolicy) {
            const amountInput = Number(req.body.depositPolicy.depositAmount);
            property.depositPolicy = {
                requireDepositBeforeAssignment: req.body.depositPolicy.requireDepositBeforeAssignment !== false,
                depositAmount: Number.isFinite(amountInput)
                    ? Math.max(0, amountInput)
                    : (property.depositPolicy?.depositAmount ?? 0)
            };
        }

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
            TenantInvitation.deleteMany({ property: req.params.id }),
            CommissionPayment.deleteMany({ property: req.params.id }),
            MaintenanceRequest.deleteMany({ property: req.params.id }),
            HolidayHold.deleteMany({ property: req.params.id }),
            TenantStay.deleteMany({ property: req.params.id }),
            HouseGroup.deleteMany({ property: req.params.id }),
            HouseApplication.deleteMany({ property: req.params.id })
        ]);

        await Property.findByIdAndDelete(req.params.id);
        res.json({ message: 'Property and all related data deleted ✅' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// TENANT INVITATIONS (property-level self-registration)
// ═══════════════════════════════════════
// Separate from Refer & Earn: different model, different URL param (?invite=),
// different code format (AR-XXXXXXXX). The browser only ever sends the code;
// landlord + property are always resolved server-side.

const INVITE_CODE_RE = /^AR-[A-Z0-9]{8}$/;

const _inviteRateLimit = new Map();
setInterval(() => sweepRateLimitMap(_inviteRateLimit, 15 * 60 * 1000), 30 * 60 * 1000);

function checkInviteRateLimit(key, max) {
    const now = Date.now(), win = 15 * 60 * 1000;
    const e = _inviteRateLimit.get(key);
    if (!e || now - e.windowStart > win) { _inviteRateLimit.set(key, { count: 1, windowStart: now }); return true; }
    if (e.count >= max) return false;
    e.count++;
    return true;
}

function generateInviteCode() {
    let s = '';
    for (let i = 0; i < 8; i++) s += REFERRAL_CODE_ALPHABET[crypto.randomInt(REFERRAL_CODE_ALPHABET.length)];
    return `AR-${s}`;
}

// Returns { inv, landlord, property } only if EVERYTHING checks out, else null.
async function resolveActiveInvitation(rawCode) {
    const code = sanitize(rawCode || '', 40).toUpperCase();
    if (!INVITE_CODE_RE.test(code)) return null;

    const inv = await TenantInvitation.findOne({ code, status: 'active' });
    if (!inv) return null;
    if (inv.expiresAt && inv.expiresAt < new Date()) return null;

    const [landlord, property] = await Promise.all([
        User.findOne({ _id: inv.landlord, role: 'landlord' }).select('name accountStatus'),
        Property.findOne({ _id: inv.property, landlord: inv.landlord }).select('name location isSuspended')
    ]);
    if (!landlord || !property) return null;                                   // also proves property belongs to landlord
    if (landlord.accountStatus === 'suspended' || property.isSuspended) return null;

    return { inv, landlord, property };
}

// ── Public: what the auth page shows when it loads ?invite=... ──
app.get('/public/invite/:code', async (req, res) => {
    try {
        if (!checkInviteRateLimit(`${req.ip}:lookup`, 300)) {
            return res.status(429).json({ valid: false, message: 'Too many requests. Please try again later.' });
        }
        const r = await resolveActiveInvitation(req.params.code);
        if (!r) return res.status(404).json({ valid: false, message: 'This invitation link is invalid or has expired.' });

        // Human-friendly only — no ids.
        res.json({ valid: true, propertyName: r.property.name, location: r.property.location || null });
    } catch (err) {
        console.error('GET /public/invite error:', err.message);
        res.status(500).json({ valid: false, message: 'Could not check this invitation.' });
    }
});

// ── Public: tenant self-registration. Re-validates the invitation itself. ──
app.post('/public/invite/:code/register', async (req, res) => {
    try {
        if (!checkInviteRateLimit(`${req.ip}:register`, 60)) {
            return res.status(429).json({ message: 'Too many attempts. Please wait 15 minutes and try again.' });
        }

        const name     = sanitize(req.body.name  || '');
        const email    = sanitize(req.body.email || '').toLowerCase();
        const phone    = sanitize(req.body.phone || '');
        const password = req.body.password;

        if (!name || !email || !phone || typeof password !== 'string' || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ message: 'Please enter a valid email address' });
        }
        if (password.length < 6 || password.length > 128) {
            return res.status(400).json({ message: 'Password must be between 6 and 128 characters' });
        }
        if (req.body.termsAccepted !== true) {
            return res.status(400).json({ message: 'You must agree to the Terms of Service and Privacy Policy' });
        }

        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ message: 'Server configuration error' });

        const r = await resolveActiveInvitation(req.params.code);
        if (!r) return res.status(404).json({ code: 'INVITE_INVALID', message: 'This invitation link is invalid or has expired.' });
        const { inv, property } = r;

        // Duplicate protection — never merge into an existing account from a public link.
        if (await User.findOne({ email })) {
            return res.status(409).json({ code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Please sign in instead.' });
        }
        if (await Tenant.findOne({ email, status: 'active' })) {
            return res.status(409).json({ code: 'ACCOUNT_EXISTS', message: 'This email is already registered as a tenant. Please sign in instead.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const tenant = await Tenant.create({
            landlord: inv.landlord, property: inv.property, name, email, phone
        });

        let user;
        try {
            user = await User.create({
                name, email, password: hashedPassword, role: 'tenant',
                tenantId: tenant._id, landlordId: inv.landlord,
                mustChangePassword: false,
                termsAcceptedAt: new Date(),
                termsVersion:    process.env.TERMS_VERSION || '1.0'
            });
        } catch (e) {
            await Tenant.deleteOne({ _id: tenant._id });   // no orphaned Tenant
            if (e.code === 11000) {
                return res.status(409).json({ code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Please sign in instead.' });
            }
            throw e;
        }

        await TenantMembership.create({
            user: user._id, landlord: inv.landlord, property: inv.property,
            tenant: tenant._id, house: null, status: 'active'
        });

        TenantInvitation.updateOne({ _id: inv._id }, { $inc: { usedCount: 1 } })
            .catch(err => console.error('invite usedCount error:', err.message));

        logActivity({
            landlord: inv.landlord, property: inv.property,
            action:   'tenant.self_registered',
            message:  `${name} joined ${property.name} through the invitation link`,
            meta:     { tenantId: tenant._id },
            actor:    'system'
        });

        const token = jwt.sign(
            { id: user._id, role: 'tenant', tenantId: tenant._id, landlordId: inv.landlord },
            secret, { expiresIn: '2h' }
        );

        res.status(201).json({ message: 'Account created', token, role: 'tenant' });

    } catch (err) {
        console.error('POST /public/invite register error:', err.message);
        res.status(500).json({ message: 'Registration failed. Please try again.' });
    }
});

// ── Landlord: current active invitation for one of THEIR properties ──
app.get('/landlord/invitations', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const propertyId = String(req.query.propertyId || '');
        if (!/^[a-f0-9]{24}$/i.test(propertyId)) return res.status(400).json({ message: 'propertyId is required' });

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id }).select('name');
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const inv = await TenantInvitation.findOne({ property: propertyId, landlord: req.user.id, status: 'active' }).lean();
        const expired = inv && inv.expiresAt && inv.expiresAt < new Date();

        res.json({
            propertyName: property.name,
            invitation: (inv && !expired)
                ? { code: inv.code, createdAt: inv.createdAt, expiresAt: inv.expiresAt, usedCount: inv.usedCount }
                : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Landlord: generate (or regenerate) — any previous active link is revoked ──
app.post('/landlord/invitations', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const propertyId = String(req.body.propertyId || '');
        if (!/^[a-f0-9]{24}$/i.test(propertyId)) return res.status(400).json({ message: 'propertyId is required' });

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id }).select('name');
        if (!property) return res.status(404).json({ message: 'Property not found' });

        // Default 90 days; 'never' or null = no expiry; otherwise 1–365 days.
        const raw = req.body.expiresInDays;
        let expiresAt = new Date(Date.now() + 90 * 86400000);
        if (raw === 'never' || raw === null) {
            expiresAt = null;
        } else if (raw !== undefined) {
            const d = Number(raw);
            if (!Number.isFinite(d) || d < 1 || d > 365) {
                return res.status(400).json({ message: 'Expiry must be between 1 and 365 days, or never' });
            }
            expiresAt = new Date(Date.now() + d * 86400000);
        }

        // Create the new link FIRST so a failure can never leave the landlord with none.
        let inv = null;
        for (let attempt = 0; attempt < 5 && !inv; attempt++) {
            try {
                inv = await TenantInvitation.create({
                    code: generateInviteCode(), landlord: req.user.id, property: propertyId, expiresAt
                });
            } catch (e) { if (e.code !== 11000) throw e; }     // code collision → retry
        }
        if (!inv) return res.status(500).json({ message: 'Could not generate a link. Please try again.' });

        await TenantInvitation.updateMany(
            { property: propertyId, landlord: req.user.id, status: 'active', _id: { $ne: inv._id } },
            { status: 'revoked', revokedAt: new Date() }
        );

        logActivity({
            landlord: req.user.id, property: propertyId,
            action: 'invitation.created',
            message: `Tenant invitation link generated for ${property.name}`
        });

        res.status(201).json({
            message: 'Invitation link generated ✅',
            invitation: { code: inv.code, createdAt: inv.createdAt, expiresAt: inv.expiresAt, usedCount: 0 }
        });
    } catch (err) {
        console.error('POST /landlord/invitations error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Landlord: revoke. Tenants who already registered are unaffected. ──
app.delete('/landlord/invitations/:propertyId', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const propertyId = String(req.params.propertyId || '');
        if (!/^[a-f0-9]{24}$/i.test(propertyId)) return res.status(400).json({ message: 'Invalid property' });

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id }).select('name');
        if (!property) return res.status(404).json({ message: 'Property not found' });

        await TenantInvitation.updateMany(
            { property: propertyId, landlord: req.user.id, status: 'active' },
            { status: 'revoked', revokedAt: new Date() }
        );
        logActivity({
            landlord: req.user.id, property: propertyId,
            action: 'invitation.revoked', message: `Tenant invitation link revoked for ${property.name}`
        });
        res.json({ message: 'Invitation link revoked' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════

app.post('/tenants/create', authMiddleware, landlordOrCaretaker, checkAccountStatus, checkPropertySuspension, checkCaretakerPropertyAccess, async (req, res) => {
    try {
        if (req.user.role === 'caretaker') {
            const caretakerCheck = await User.findById(req.user.id).select('caretakerPermissions');
            if (!caretakerCheck?.caretakerPermissions?.canManageTenants) {
                return res.status(403).json({ message: 'You do not have permission to add tenants' });
            }
        }

        // FIX Bug 22: sanitize inputs
        const name       = sanitize(req.body.name  || '');
        const email      = sanitize(req.body.email || '').toLowerCase();
        const phone      = sanitize(req.body.phone || '');
        const houseId    = req.body.houseId    || null;
        const propertyId = req.body.propertyId || null;

        if (!name || !email || !phone) {
            return res.status(400).json({ message: 'name, email and phone are required' });
        }
        if (!propertyId) {
            return res.status(400).json({ message: 'propertyId is required' });
        }

        const landlordScope = await resolveLandlordScope(req);
        const property = await Property.findOne({ _id: propertyId, landlord: landlordScope });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const actorName = await getActorName(req);

        // FIX (plans → commission migration): no more tenant-cap check — unlimited tenants per property.
        const landlordUser = await User.findById(landlordScope);

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

        // FIX (account hijack): look up any existing User for this email
        // BEFORE creating the Tenant document, so a blocked request never
        // leaves an orphaned Tenant record with no linked User.
        //
        // Only a 'tenant' role account (or no account at all) is eligible
        // for the "returning tenant" merge path below. If this email
        // belongs to a landlord, caretaker, or any other role, merging
        // would silently overwrite that account's landlordId/tenantId and
        // hijack it into this landlord's tenant roster — which is exactly
        // the bug this guard closes.
        const existingUser = await User.findOne({ email });
        if (existingUser && existingUser.role !== 'tenant') {
            return res.status(400).json({
                message: 'This email is already registered to a different type of account and cannot be used for a tenant.'
            });
        }

        let house = null;
        if (houseId) {
            house = await House.findOne({ _id: houseId, property: propertyId, landlord: landlordScope });
            if (!house)                      return res.status(404).json({ message: 'House not found' });
            if (house.status === 'occupied') return res.status(400).json({ message: 'House is already occupied' });
        }

        // A new tenant has NO due date and NO rent cycle until they are assigned a house — they start
        // out "Not assigned". Only when a house is supplied right here does the cycle start now.
        const assignedNow = new Date();
        const tenantData = {
            landlord: landlordScope,
            property: propertyId,
            name,
            email,
            phone,
            ...(houseId && { house: houseId, assignedAt: assignedNow, cycleAnchor: assignedNow })
        };

        const tenant = await Tenant.create(tenantData);

        if (house) {
            await House.findByIdAndUpdate(houseId, { status: 'occupied' });
        }

        let isReturning  = false;
        let userId;
        let tempPassword = null;

        if (existingUser) {
            // Returning tenant: keep their own account (password and name) and link it to this landlord.
            existingUser.landlordId = landlordScope;
            existingUser.tenantId   = tenant._id;
            await existingUser.save();
            isReturning = true;
            userId      = existingUser._id;
        } else {
            tempPassword = crypto.randomBytes(6).toString('base64').slice(0, 8);
            const hashedPassword = await bcrypt.hash(tempPassword, 10);

            const newUser = await User.create({
                name,
                email,
                password:           hashedPassword,
                role:               'tenant',
                tenantId:           tenant._id,
                landlordId:         landlordScope,
                mustChangePassword: true
            });

            userId = newUser._id;
        }

        await TenantMembership.create({
            user:     userId,
            landlord: landlordScope,
            property: propertyId,
            tenant:   tenant._id,
            house:    houseId || null,
            status:   'active'
        });

        // Exactly ONE email, and only after the account and membership both exist.
        sendTenantWelcomeEmail({
            name:         isReturning ? (existingUser.name || name) : name,
            email,
            tempPassword,
            isReturning,
            propertyName: property.name,
            landlordName: landlordUser.name
        }).catch(err => console.error('Tenant welcome email failed:', err.message));

        logActivity({
            landlord: landlordScope, property: propertyId,
            action:   isReturning ? 'tenant.readded' : 'tenant.created',
            message:  `${name} was ${isReturning ? 're-added to' : 'created for'} ${property.name}${actorName ? ` — by ${actorName}` : ''}`,
            meta:     { tenantId: tenant._id, actorName },
            actor:    actorName ? 'caretaker' : 'landlord'
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

app.put('/assign-house/:tenantId/:houseId', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const { tenant, house } = await assignTenantToHouse(req, {
            tenantId: req.params.tenantId,
            houseId:  req.params.houseId
        });
        res.json({ message: 'House assigned successfully ✅', tenant, house });
    } catch (err) {
        if (err && err.httpStatus) {
            return res.status(err.httpStatus).json({ message: err.message, ...(err.extra || {}) });
        }
        console.error('assign-house error:', err);
        res.status(500).json({ message: err.message });
    }
});

// ═══════════════════════════════════════
// TRANSFER HOUSE
// ═══════════════════════════════════════
// Moves an active tenant to another house of the SAME property (within a building or across
// buildings). Same tenant, same payments/receipts/arrears — see services/transfer.js.

app.put('/tenants/:id/transfer-house', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const out = await transferTenantToHouse(req, { tenantId: req.params.id, toHouseId: req.body.houseId });
        res.json({ message: `${out.tenant.name} moved to ${out.toHouse.name} ✅`, ...out });
    } catch (err) {
        if (err && err.httpStatus) {
            return res.status(err.httpStatus).json({ message: err.message, ...(err.extra || {}) });
        }
        console.error('transfer-house error:', err);
        res.status(500).json({ message: err.message });
    }
});

// ═══════════════════════════════════════
// MONTHLY DUE / END DATE — landlord adjustment
// ═══════════════════════════════════════
// Moves ONLY the end/due date of the tenant's current monthly cycle (e.g. 10 Dec → 20 Dec). No extra
// charge is made, the period label and rent are untouched, and the NEXT cycle starts on the new date
// (20 Dec → 20 Jan). The adjusted date is stored apart from the automatically derived dates, so a
// recalculation can never overwrite it. Semester tenants keep their existing "Extend Stay".

app.put('/tenants/:id/cycle-end', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        if (!/^[a-f0-9]{24}$/i.test(String(req.params.id))) return res.status(404).json({ message: 'Tenant not found' });

        const newEnd = parseDateOnly(req.body.newEndDate);
        if (!newEnd) return res.status(400).json({ message: 'A valid new date is required (YYYY-MM-DD)' });

        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: req.user.id, status: 'active' }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Active tenant not found' });
        if (!tenant.house) {
            return res.status(400).json({ message: 'This tenant has no house yet — their rent cycle starts when they are assigned one' });
        }
        if ((tenant.house.billingCycle || 'monthly') !== 'monthly') {
            return res.status(400).json({ message: 'This tenant is on semester billing — use "Extend Stay" instead' });
        }

        if (await HolidayHold.exists({ tenant: tenant._id, status: 'active' })) {
            return res.status(409).json({ message: 'This tenant is on holiday — record their return first. Their rent cycle restarts on the day they are back.' });
        }

        const now        = new Date();
        const cycle      = computeMonthlyCycle(tenant, now);
        const automatic  = cycle.originalEnd;                       // the end date the system derives on its own
        const previousEnd = cycle.end;                              // what is in force right now

        if (!(startOfDay(newEnd) > startOfDay(automatic))) {
            return res.status(400).json({ message: `The new date must be after the automatic end date (${toISODate(automatic)}).` });
        }
        if (dayDiff(newEnd, automatic) > 366) {
            return res.status(400).json({ message: 'The new date cannot be more than 366 days after the automatic end date.' });
        }

        const wasLegacy = !tenant.cycleAnchor;
        tenant.cycleEndOverride = {
            date: startOfDay(newEnd), cycleStart: cycle.start, originalEnd: automatic,
            setAt: now, setBy: req.user.id
        };
        // A legacy (calendar-month) tenant joins the anniversary cycle from the date the landlord set.
        if (wasLegacy) tenant.cycleAnchor = startOfDay(newEnd);
        await tenant.save();

        logActivity({
            landlord: req.user.id, property: tenant.property,
            action:   'tenant.cycle_end_adjusted',
            message:  `${tenant.name}'s due date moved from ${toISODate(previousEnd)} to ${toISODate(newEnd)} (no extra charge; next cycle starts that day)`,
            meta:     { tenantId: tenant._id, from: toISODate(previousEnd), to: toISODate(newEnd) }
        });

        res.json({
            message:       `Due date moved to ${toISODate(newEnd)} ✅ No extra charge — the next cycle starts on that date.`,
            previousEndISO: toISODate(previousEnd),
            newEndISO:      toISODate(newEnd),
            stay:           await getStayProgressForTenant(tenant, null, now)
        });
    } catch (err) {
        console.error('cycle-end error:', err);
        res.status(500).json({ message: err.message });
    }
});

// ═══════════════════════════════════════
// MOVE OUT
// ═══════════════════════════════════════

// FIX Bug 10: guard against calling move-out on already moved-out tenant
app.put('/move-out/:tenantId', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        if (req.user.role === 'caretaker') {
            const caretakerCheck = await User.findById(req.user.id).select('caretakerPermissions');
            if (!caretakerCheck?.caretakerPermissions?.canManageTenants) {
                return res.status(403).json({ message: 'You do not have permission to move out tenants' });
            }
        }

        const landlordScope = await resolveLandlordScope(req);
        const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: landlordScope });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(tenant.property));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        // FIX Bug 10
        if (tenant.status === 'moved_out') {
            return res.status(400).json({ message: 'Tenant has already been moved out' });
        }
        if (!tenant.house) return res.status(400).json({ message: 'This tenant is not assigned to any house' });

        const house = await House.findOne({ _id: tenant.house, landlord: landlordScope });
        if (!house) return res.status(404).json({ message: 'House not found' });

        const actorName = await getActorName(req);

        tenant.lastHouse    = tenant.house;
        tenant.lastProperty = tenant.property;
        tenant.lastLandlord = tenant.landlord;
        tenant.status       = 'moved_out';
        tenant.movedOutAt   = new Date();
        tenant.house        = null;

        house.status = 'available';
                // A tenant moving out ends any holiday hold (this is the "never returned" conversion)
        await HolidayHold.updateMany({ tenant: tenant._id, status: 'active' }, { status: 'ended', endedAt: new Date() });

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
            landlord: landlordScope, property: tenant.property,
            action:   'tenant.moved_out',
            message:  `${tenant.name} moved out of ${house.name}${actorName ? ` — by ${actorName}` : ''}`,
            meta:     { tenantId: tenant._id, houseId: house._id, actorName },
            actor:    actorName ? 'caretaker' : 'landlord'
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
        await HouseApplication.deleteMany({ tenant: req.params.id });

        await HolidayHold.deleteMany({ tenant: req.params.id });
        await TenantStay.deleteOne({ tenant: req.params.id });

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
        if (req.user.role === 'landlord' || req.user.role === 'caretaker') {
            const landlordScope = await resolveLandlordScope(req);
            const query = { landlord: landlordScope };

            const statusParam = req.query.status;
            if (!statusParam || statusParam === 'active') {
                query.status = 'active';
            } else if (statusParam === 'moved_out') {
                query.status = 'moved_out';
            }

            // ── Caretakers are further restricted to their assigned properties ──
            let caretakerPropertyIds = null;
            if (req.user.role === 'caretaker') {
                const caretaker = await User.findById(req.user.id).select('properties');
                caretakerPropertyIds = (caretaker.properties || []).map(String);
            }

            if (req.query.propertyId) {
                if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                    return res.status(403).json({ message: 'You are not assigned to this property' });
                }
                const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
                if (!property) return res.status(404).json({ message: 'Property not found' });
                query.property = req.query.propertyId;
            } else if (caretakerPropertyIds) {
                query.property = { $in: caretakerPropertyIds };
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

        let query;
        if (req.user.role === 'landlord') {
            query = { _id: req.params.id, landlord: req.user.id };
        } else if (req.user.role === 'caretaker') {
            const landlordScope       = await resolveLandlordScope(req);
            const caretaker           = await User.findById(req.user.id).select('properties');
            const caretakerPropertyIds = (caretaker.properties || []).map(String);
            query = { _id: req.params.id, landlord: landlordScope, property: { $in: caretakerPropertyIds } };
        } else {
            query = { _id: req.params.id };
        }

        const tenant = await Tenant.findOne(query)
            .populate('house')
            .populate('property', 'name location')
            .populate('lastProperty', 'name location')
            .populate('lastHouse', 'name rent');

        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        // AFTER
        // FIX: rent-only ledger for the payment history shown to the tenant/landlord
        const payments  = await Payment.find({ tenant: tenant._id, category: 'rent', status: { $in: ['paid', 'partial'] } });
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

        // FIX: arrears must respect semester billing / Billing docs, not a flat house.rent guess.
        // Sum true per-period balances across every month this tenant has a rent record for,
        // using the same getEffectiveRentForTenant + getMonthSummary logic used everywhere else.
        const rentSource = tenant.status === 'moved_out' ? tenant.lastHouse : tenant.house;
        const effectiveTenant = { ...tenant.toObject(), house: rentSource };

        const periodsToCheck = new Set(payments.map(p => p.periodLabel || p.month));
        let holdList = null, semRule = null, curKey = null, stayProp = null, cur = null, holdDocs = [], monthlyPaused = false;
        const nowForPeriod = new Date();

        if (tenant.status === 'active' && tenant.house) {
            const propDoc = await Property.findById(tenant.property._id || tenant.property).select('name semesterRule monthlyHoldingFee');
            stayProp      = propDoc;
            await settleGapHolds({ tenant: tenant._id });                 // a gap hold ends the day the next semester starts
            cur           = await getCurrentPeriodKeyForTenant(tenant, propDoc);
            holdDocs      = await HolidayHold.find({ tenant: tenant._id, status: { $in: ['active', 'returned'] } })
                .sort({ createdAt: -1 }).limit(20).lean();

            if ((tenant.house.billingCycle || 'monthly') === 'semester') {
                semRule = normalizeSemesterRule(propDoc?.semesterRule || {});
                // The property's gap policy ("auto" / "none") decides for the landlord, once, at the start of a gap.
                if (cur && cur.mode === 'between') {
                    const made = await applyGapPolicyIfNeeded({ tenant, property: propDoc, rule: semRule, ctx: cur.ctx, holds: holdDocs });
                    if (made) holdDocs.unshift(made.toObject());
                }
                holdList = holdDocs;
            }
            if (cur) {
                curKey = cur.key;
                // A semester that has not started yet is not owed; a monthly cycle that began during a holiday is paused.
                const notStarted = cur.cycle === 'semester' && cur.started === false;
                if (cur.cycle === 'monthly') monthlyPaused = holdExcludesWindow(holdDocs, { startDate: cur.cycleStart, endDate: cur.cycleEnd });
                if (!notStarted && !monthlyPaused) periodsToCheck.add(cur.key);
            }
        }

        let arrears = 0;
        for (const m of periodsToCheck) {
            if (semRule && semRule.enabled) {
                const w = findSemesterWindowByLabel(semRule, m);
                if (w && w.startDate > nowForPeriod) continue;                  // not started yet → not an arrear
                if (w && holdList && holdExcludesWindow(holdList, w)) continue;
            }
            const periodRent = await getEffectiveRentForTenant(effectiveTenant, m);
            const summary     = await getMonthSummary(tenant._id, m, periodRent);
            arrears += summary.balance;
        }

        // ── Status. A tenant with no house has not entered a rent cycle, so having "no unpaid balance"
        //    must never read as "all paid". "all_paid" only when the current period's rent is settled. ──
        const assignment = tenant.status === 'moved_out' ? 'moved_out' : (tenant.house ? 'assigned' : 'not_assigned');
        let payment = assignment;                          // 'moved_out' | 'not_assigned' pass straight through
        if (assignment === 'assigned') {
            if (!curKey) {
                payment = 'unknown';                       // e.g. semester billing not configured yet
            } else if (cur.cycle === 'semester' && cur.started === false) {
                payment = 'upcoming';                      // next semester has not started — nothing is owed yet
            } else {
                let rentPaused = monthlyPaused;
                if (cur.cycle === 'semester' && holdList) rentPaused = !!holdExcludesWindow(holdList, cur.window);
                if (rentPaused)        payment = 'paused';
                else if (arrears > 0)  payment = 'arrears';
                else {
                    const curRent    = await getEffectiveRentForTenant(effectiveTenant, curKey);
                    const curSummary = await getMonthSummary(tenant._id, curKey, curRent);
                    payment = curSummary.status === 'paid' ? 'all_paid' : 'unpaid';
                }
            }
        }

        const stay   = await getStayProgressForTenant(tenant, stayProp);
        const period = await buildTenantPeriodSummary(tenant, stayProp, holdDocs, nowForPeriod, cur);

        res.json({ tenant, payments, totalPaid, arrears, status: { assignment, payment }, stay, period });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// TENANT SELF-SERVICE OVERVIEW
// ═══════════════════════════════════════
//
// Single server-side source of truth for everything the tenant dashboard
// shows about billing, stay, holiday and deposit. It reuses the SAME helpers
// the landlord side uses, so the two sides cannot drift. Scoped strictly to
// the token's tenantId — no id parameter is accepted.
app.get('/tenant/me/overview', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant' || !req.user.tenantId) {
            return res.status(403).json({ message: 'Tenants only' });
        }

        const tenant = await Tenant.findById(req.user.tenantId)
            .populate('house')
            .populate('lastHouse', 'name')
            .populate('lastProperty', 'name location');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const property   = await Property.findById(tenant.property).select('name location depositPolicy semesterRule');
        const now        = new Date();
        const isMovedOut = tenant.status === 'moved_out';
        const house      = (!isMovedOut && tenant.house) ? tenant.house : null;
        const cycle      = house ? (house.billingCycle || 'monthly') : null;

        // ── Deposit ──
        const policy          = property?.depositPolicy || {};
        const requiredDeposit = Number(policy.depositAmount || 0);
        const requireBefore   = policy.requireDepositBeforeAssignment !== false;
        const validDeposit    = property ? tenantHasValidDeposit(tenant, property) : false;
        const deposit = {
            status:                   tenant.depositStatus || 'none',
            amountPaid:               Number(tenant.depositAmount || 0),
            paidAt:                   tenant.depositPaidAt || null,
            required:                 requiredDeposit,
            requiredBeforeAssignment: requireBefore,
            paidForThisProperty:      validDeposit,
            blockingAssignment:       !isMovedOut && !tenant.house && requireBefore && !validDeposit
        };

        // ── Holiday holds (all, newest first) ──
        await settleGapHolds({ tenant: tenant._id });      // a between-semesters hold ends the day the next semester starts
        const holdDocs = await HolidayHold.find({ tenant: tenant._id }).sort({ createdAt: -1 }).limit(20);
        const holdPaid = await getHoldPaidMap(holdDocs.map(h => h._id));
        const holds = holdDocs.map(h => ({
            ...formatHold(h, holdPaid[String(h._id)] || 0, now),
            feePerDay: Number(h.feeAmount || 0) / 30
        }));
        const activeHold            = holds.find(h => h.status === 'active') || null;
        const outstandingHoldingFee = holds.reduce((sum, h) => sum + h.balance, 0);

        // ── Current billing period ──
        let current = null, academicYear = null, between = null, canPayRent = false, payBlockedReason = null;

        if (isMovedOut)  payBlockedReason = 'MOVED_OUT';
        else if (!house) payBlockedReason = 'NO_HOUSE';

        if (house && cycle === 'monthly') {
            // Anniversary cycle from the assignment date (legacy calendar month for older tenants).
            const mc          = computeMonthlyCycle(tenant, now);
            const periodLabel = mc.key;
            const rent        = await getEffectiveRentForTenant(tenant, periodLabel);
            const summary     = await getPeriodSummary(tenant._id, periodLabel, rent, 'monthly');
            const dueDate     = mc.due;
            const dueDay      = dueDate.getDate();
            const daysToDue   = dayDiff(dueDate, now);
            // A cycle that began while the tenant was away on holiday is paused (the holding fee applies instead).
            const rentPaused  = holdExcludesWindow(holdDocs, { startDate: mc.start, endDate: mc.end });

            current = {
                cycle: 'monthly', periodLabel, dueDay,
                startISO:   toISODate(mc.start), endISO: toISODate(mc.end),
                dueDateISO: toISODate(dueDate), daysToDue,
                dateAdjusted: mc.isOverride, anniversary: mc.mode === 'anniversary',
                overdue:    !rentPaused && summary.balance > 0 && daysToDue < 0,
                amountDue:  rentPaused ? 0 : rent, paid: summary.totalPaid, balance: rentPaused ? 0 : summary.balance,
                status:     rentPaused ? 'paused' : summary.status, rentPaused
            };
            canPayRent = !rentPaused;
            if (rentPaused) payBlockedReason = 'RENT_PAUSED';
        }

        if (house && cycle === 'semester') {
            const rule = normalizeSemesterRule(property?.semesterRule || {});

            if (!rule.enabled) {
                payBlockedReason = 'SEMESTER_NOT_CONFIGURED';
            } else {
                const ctx = await getSemesterContext(rule, tenant, now);
                if (ctx.mode === 'between') {
                    let gap = getGapStatus(ctx, holdDocs, rule);
                    let createdNow = null;
                    if (gap && gap.decisionNeeded && gap.policy !== 'ask') {
                        const made = await applyGapPolicyIfNeeded({ tenant, property, rule, ctx, holds: holdDocs });
                        if (made) { gap = { ...gap, decisionNeeded: false, coveredBy: String(made._id) }; createdNow = made; }
                    }
                    if (gap) {
                        const cover  = createdNow || (gap.coveredBy ? holdDocs.find(h => String(h._id) === gap.coveredBy) : null);
                        const prevLb = formatSemesterPeriodLabel(ctx.window);
                        const prevSm = await getPeriodSummary(tenant._id, prevLb, await getEffectiveRentForTenant(tenant, prevLb), 'semester');
                        between = {
                            prevLabel: gap.prevLabel, nextLabel: gap.nextLabel,
                            gapStartISO: gap.gapStartISO, nextStartISO: gap.nextStartISO, days: gap.days,
                            decided: !gap.decisionNeeded, feeAmount: cover ? Number(cover.feeAmount || 0) : null,
                            previousLabel: prevLb, previousBalance: prevSm.balance
                        };
                    }
                }

                const window      = getSemesterWindowContaining(rule, now);
                const periodLabel = formatSemesterPeriodLabel(window);

                const billing = await Billing.findOne({
                    landlord: tenant.landlord, tenant: tenant._id, house: house._id, periodLabel
                }).sort({ createdAt: -1 });

                const rent    = await getEffectiveRentForTenant(tenant, periodLabel);
                const summary = await getPeriodSummary(tenant._id, periodLabel, rent, 'semester');

                const holdMap    = await getActiveHoldMap([tenant._id]);
                const rentPaused = holdExcludesWindow(holdMap.get(String(tenant._id)), window);

                const extensionDays   = Number(billing?.extensionDays   || 0);
                const extensionCharge = Number(billing?.extensionCharge || 0);
                const effectiveEnd    = billing?.extendedEndDate || window.endDate;
                const dueDate         = billing?.dueDateActual   || computeSemesterDueDate(window);
                const totalDays       = semesterTotalDaysOf(window);
                const daysToDue       = dayDiff(dueDate, now);
                const balance         = rentPaused ? 0 : summary.balance;

                current = {
                    cycle: 'semester', periodLabel,
                    semesterLabel:    window.semesterLabel,
                    startISO:         toISODate(window.startDate),
                    endISO:           toISODate(window.endDate),
                    effectiveEndISO:  toISODate(effectiveEnd),
                    notStarted:       window.startDate > now,
                    daysToStart:      dayDiff(window.startDate, now),
                    daysToEnd:        dayDiff(effectiveEnd, now),
                    extensionDays, extensionCharge,
                    fullSemesterRent: window.rentAmount,
                    baseAmountDue:    rent - extensionCharge,
                    totalDays,
                    dailyRate:        window.rentAmount / totalDays,
                    dueDateISO:       toISODate(dueDate), daysToDue,
                    overdue:          !rentPaused && balance > 0 && daysToDue < 0,
                    amountDue:        rentPaused ? 0 : rent,
                    paid:             summary.totalPaid,
                    balance,
                    status:           rentPaused ? 'paused' : summary.status,
                    rentPaused
                };
                canPayRent = !rentPaused;
                if (rentPaused) payBlockedReason = 'RENT_PAUSED';

                // ── Academic year ──
                const ay        = getCurrentAcademicYear(rule, now);
                const stay      = await TenantStay.findOne({ tenant: tenant._id }).lean();
                const staysFrom = tenant.assignedAt || tenant.createdAt || now;
                const semesters = ay.windows.map(w => ({
                    sequence:    w.sequence,
                    label:       w.semesterLabel,
                    periodLabel: formatSemesterPeriodLabel(w),
                    startISO:    toISODate(w.startDate),
                    endISO:      toISODate(w.endDate),
                    completed:   w.endDate >= staysFrom && w.endDate < now,
                    current:     formatSemesterPeriodLabel(w) === periodLabel
                }));
                const semestersCompleted = semesters.filter(s => s.completed).length;
                const expected           = stay?.expectedSemesterCount || null;
                academicYear = {
                    label: ay.label, semesters,
                    expectedSemesterCount: expected,
                    semestersCompleted,
                    complete: !!expected && semestersCompleted >= expected
                };
            }
        }

        res.json({
            status:       tenant.status,
            isMovedOut,
            billingCycle: cycle,
            assignedAt:   tenant.assignedAt || null,
            stay:         await getStayProgressForTenant(tenant, property, now),
            property:     { name: property?.name || null, location: property?.location || null },
            house:        house ? { name: house.name, billingCycle: cycle, status: house.status } : null,
            current, academicYear, between,
            canPayRent, payBlockedReason,
            deposit,
            hold: activeHold, holds, outstandingHoldingFee,
            unreadNotifications: await TenantNotification.countDocuments({ tenant: tenant._id, readAt: null }),
            movedOut: isMovedOut ? {
                movedOutAt:   tenant.movedOutAt || null,
                lastProperty: tenant.lastProperty ? { name: tenant.lastProperty.name, location: tenant.lastProperty.location } : null,
                lastHouse:    tenant.lastHouse    ? { name: tenant.lastHouse.name } : null
            } : null
        });

    } catch (err) {
        console.error('GET /tenant/me/overview error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ═══════════════════════════════════════
// HOUSES
// ═══════════════════════════════════════

app.post('/houses', authMiddleware, landlordOnly, checkAccountStatus, checkPropertySuspension, async (req, res) => {
    try {
        const propertyId   = req.body.propertyId || null;
        const name         = sanitize(req.body.name || '');
        const billingCycle = ['monthly', 'semester'].includes(req.body.billingCycle) ? req.body.billingCycle : 'monthly';
        const amountDue    = req.body.amountDue !== undefined ? Number(req.body.amountDue) : undefined;

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });
        if (amountDue !== undefined && (!Number.isFinite(amountDue) || amountDue < 0)) {
            return res.status(400).json({ message: 'amountDue must be a valid non-negative number' });
        }

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        let rent;
        if (billingCycle === 'semester') {
            rent = Number(property.semesterRule?.rentAmount || 0);
            if (!rent || rent <= 0) {
                return res.status(400).json({ message: "Set the semester rent amount for this property before adding semester-billed houses." });
            }
        } else {
            rent = Number(req.body.rent);
            if (!rent || rent <= 0) return res.status(400).json({ message: 'A valid rent amount is required' });
        }

 // Optional: place the new house in a building (must be THIS landlord's building in THIS property)
        let placement = { group: null, groupSeq: null };
        if (req.body.groupId) {
            try {
                placement = await resolvePlacement({
                    landlord: req.user.id, property: propertyId, buildingId: req.body.groupId, houseName: name
                });
            } catch (e) {
                if (e.httpStatus) return res.status(e.httpStatus).json({ message: e.message });
                throw e;
            }
        }

        const house = await House.create({
            name, rent, landlord: req.user.id, property: propertyId, billingCycle,
            ...(amountDue !== undefined && { amountDue }),
            ...(placement.group && { group: placement.group, groupSeq: placement.groupSeq })
        });

        res.status(201).json(house);
    } catch (err) {
        if (err && err.code === 11000) {
            return res.status(400).json({ message: 'A house with that name already exists in this property' });
        }
        res.status(500).json({ error: err.message });
    }
});
app.get('/houses', authMiddleware, async (req, res) => {
    try {
        if (req.user.role === 'landlord' || req.user.role === 'caretaker') {
            const landlordScope = await resolveLandlordScope(req);
            const query = { landlord: landlordScope };

            let caretakerPropertyIds = null;
            if (req.user.role === 'caretaker') {
                const caretaker = await User.findById(req.user.id).select('properties');
                caretakerPropertyIds = (caretaker.properties || []).map(String);
            }

            if (req.query.propertyId) {
                if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                    return res.status(403).json({ message: 'You are not assigned to this property' });
                }
                const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
                if (!property) return res.status(404).json({ message: 'Property not found' });
                query.property = req.query.propertyId;
            } else if (caretakerPropertyIds) {
                query.property = { $in: caretakerPropertyIds };
            }

           
            const houses = await House.find(query)
                .populate('property', 'name')
                .populate('group', 'label prefix padWidth colorIndex icon description createdAt')
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
        const allowed = ['name', 'rent', 'billingCycle', 'amountDue'];
        const updates = {};
        for (const field of allowed) {
            if (req.body[field] === undefined) continue;

            if (field === 'billingCycle') {
                if (!['monthly', 'semester'].includes(req.body.billingCycle)) {
                    return res.status(400).json({ message: 'billingCycle must be monthly or semester' });
                }
                updates.billingCycle = req.body.billingCycle;
            } else if (field === 'amountDue') {
                const amt = Number(req.body.amountDue);
                if (!Number.isFinite(amt) || amt < 0) {
                    return res.status(400).json({ message: 'amountDue must be a valid non-negative number' });
                }
                updates.amountDue = amt;
            } else {
                updates[field] = typeof req.body[field] === 'string'
                    ? sanitize(req.body[field])
                    : req.body[field];
            }
        }

        const before = await House.findOne({ _id: req.params.id, landlord: req.user.id });
        if (!before) return res.status(404).json({ message: 'House not found' });

        if (before.status === 'occupied') {
            // Switching an occupied house between monthly and semester would change how its tenant is billed overnight.
            if (updates.billingCycle && updates.billingCycle !== (before.billingCycle || 'monthly')) {
                return res.status(400).json({ message: 'This house is occupied, so its billing cycle cannot be changed. Move the tenant out (or transfer them) first.' });
            }
            // A rent change must not reprice months that are already past: the old rent is kept for the cycle that is
            // running and everything before it, and the new rent applies from the next cycle.
            const newRent = updates.rent !== undefined ? Number(updates.rent) : null;
            if ((before.billingCycle || 'monthly') === 'monthly' && newRent !== null && Number.isFinite(newRent) && newRent !== Number(before.rent)) {
                const now = new Date();
                const occupants = await Tenant.find({ house: before._id, status: 'active', landlord: req.user.id });
                for (const t of occupants) {
                    const last = t.houseHistory && t.houseHistory.length ? t.houseHistory[t.houseHistory.length - 1] : null;
                    t.houseHistory.push({
                        house: before._id, houseName: before.name, rent: Number(before.rent || 0), billingCycle: 'monthly',
                        from: (last && last.to) || t.assignedAt || t.createdAt || null, to: now,
                        lastPeriodStart: computeMonthlyCycle(t, now).start
                    });
                    await t.save();
                }
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

        let conflicts = [];
        const propertyId = req.body.propertyId || null;
        if (propertyId) {
            const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
            if (property) {
                const existing = await House.find({ property: propertyId, name: { $in: names } })
                    .select('name group')
                    .populate('group', 'label prefix');
                conflicts = existing.map(h => ({
                    name:       h.name,
                    groupLabel: h.group?.label || h.group?.prefix || 'Ungrouped'
                }));
            }
        }

        res.json({
            names,
            count: names.length,
            hasDuplicatesInBatch: dupes.length > 0,
            duplicates: [...new Set(dupes)],
            conflicts
        });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// ── Actual bulk-create ──
app.post('/houses/generate', authMiddleware, landlordOnly, checkAccountStatus, checkPropertySuspension, async (req, res) => {
    try {
        const propertyId   = req.body.propertyId || null;
        const billingCycle = ['monthly', 'semester'].includes(req.body.billingCycle) ? req.body.billingCycle : 'monthly';

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });

        const property = await Property.findOne({ _id: propertyId, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        // Optional: generate INTO an existing building (the landlord opened the generator from it).
        // The building must be THIS landlord's, in THIS property. Without groupId nothing changes:
        // every naming group still becomes its own new building, exactly as before.
        let targetGroup = null, targetHasHouses = false;
        if (req.body.groupId) {
            if (!/^[a-f0-9]{24}$/i.test(String(req.body.groupId))) return res.status(400).json({ message: 'Invalid building' });
            targetGroup = await HouseGroup.findOne({ _id: req.body.groupId, landlord: req.user.id, property: propertyId });
            if (!targetGroup) return res.status(404).json({ message: 'Building not found' });
            targetHasHouses = !!(await House.exists({ group: targetGroup._id }));
        }

        let rent;
        if (billingCycle === 'semester') {
            rent = Number(property.semesterRule?.rentAmount || 0);
            if (!rent || rent <= 0) {
                return res.status(400).json({ message: "Set the semester rent amount for this property before generating semester-billed units." });
            }
        } else {
            rent = Number(req.body.rent);
            if (!rent || rent <= 0) return res.status(400).json({ message: 'A valid rent amount is required' });
        }

        const floors = Array.isArray(req.body.config?.floors) ? req.body.config.floors : [];
        
        if (!floors.length) return res.status(400).json({ message: 'At least one naming group is required' });
        if (targetGroup && floors.length !== 1) {
            return res.status(400).json({ message: 'Houses are added to a building one naming group at a time' });
        }

        // A building that already has houses keeps its own prefix/padding, so names (and a later
        // "Extend") stay consistent. An empty building adopts the prefix/padding chosen here.
        if (targetGroup && targetHasHouses) {
            floors[0].prefix   = targetGroup.prefix || '';
            floors[0].padWidth = targetGroup.padWidth || 0;
        }

        // ── Every group must have its own identity, independent of its prefix.
        //    This is what lets two groups both use "Room" without becoming
        //    indistinguishable in the UI later. (A target building already has its name.) ──
        for (const floor of (targetGroup ? [] : floors)) {
            if (!sanitize(floor.label || '', 60)) {
                return res.status(400).json({
                    message: 'Each group needs a name (e.g. "Sunrise Tower" or "Annex Block") before generating houses.'
                });
            }
        }

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

        // ── Conflict check now resolves which GROUP already owns each
        //    colliding name, so the frontend can say "belongs to Sunrise
        //    Tower" instead of just listing bare names. ──
        const existing = await House.find({ property: propertyId, name: { $in: allNames } })
            .select('name group')
            .populate('group', 'label prefix');
        if (existing.length) {
            const conflicts = existing.slice(0, 20).map(h => ({
                name:       h.name,
                groupLabel: h.group?.label || h.group?.prefix || 'Ungrouped'
            }));
            return res.status(400).json({
                message:        `${existing.length} name(s) already exist in this property`,
                conflicts,
                totalConflicts: existing.length
            });
        }

        // ── Non-blocking: detect and log prefix reuse against groups that
        //    already existed before this request, for later audit trail. ──
        const existingGroupsForReuseCheck = await HouseGroup.find({ property: propertyId }).select('label prefix');
        const reuseNotices = [];
        for (const floor of (targetGroup ? [] : floors)) {
            const prefixTrim = (typeof floor.prefix === 'string' ? floor.prefix : '').trim().toLowerCase();
            if (!prefixTrim) continue;
            const match = existingGroupsForReuseCheck.find(g => (g.prefix || '').trim().toLowerCase() === prefixTrim);
            if (match) {
                reuseNotices.push({
                    newLabel:       floor.label,
                    prefix:         floor.prefix,
                    existingGroupId: match._id,
                    existingLabel:  match.label
                });
            }
        }

        // Each floor/group in the request becomes its own HouseGroup document,
        // so it can be extended later and gets its own color.
        const existingGroupCount = await HouseGroup.countDocuments({ property: propertyId });
        let colorCursor = existingGroupCount;

        const createdHouses = [];
        for (const { floor, pairs } of perFloorPairs) {
            if (!pairs.length) continue;

            let group;
            if (targetGroup) {
                group = targetGroup;
                if (!targetHasHouses) {
                    // Stored EXACTLY as the names were built (no trimming) — same as a new group — so a later
                    // "Extend" continues the numbering identically (e.g. prefix "Room " → "Room 4").
                    group.prefix   = typeof floor.prefix === 'string' ? floor.prefix : '';
                    group.padWidth = Number.isFinite(Number(floor.padWidth)) ? Number(floor.padWidth) : 0;
                    await group.save();
                }
            } else {
                group = await HouseGroup.create({
                    landlord:   req.user.id,
                    property:   propertyId,
                    label:      sanitize(floor.label || '', 60),
                    prefix:     typeof floor.prefix === 'string' ? floor.prefix : '',
                    padWidth:   Number.isFinite(Number(floor.padWidth)) ? Number(floor.padWidth) : 0,
                    colorIndex: colorCursor % 8
                });
                colorCursor++;
            }

            const docs = pairs.map(p => ({
                name: p.name, rent, landlord: req.user.id, property: propertyId,
                group: group._id, groupSeq: p.seq, billingCycle
            }));
            const created = await House.insertMany(docs);
            createdHouses.push(...created);
        }

        logActivity({
            landlord: req.user.id, property: propertyId,
            action:  'houses.bulk_generated',
            message: targetGroup
                ? `${createdHouses.length} units added to "${targetGroup.label}" in ${property.name}`
                : `${createdHouses.length} units generated for ${property.name}`,
            meta:    { count: createdHouses.length, ...(targetGroup && { groupId: targetGroup._id }) }
        });

        reuseNotices.forEach(n => {
            logActivity({
                landlord: req.user.id, property: propertyId,
                action:  'houses.prefix_reused',
                message: `Prefix "${n.prefix}" used in new group "${n.newLabel}" is also used by existing group "${n.existingLabel}" in ${property.name} — check numbering doesn't overlap`,
                meta:    { prefix: n.prefix, newGroupLabel: n.newLabel, existingGroupId: n.existingGroupId, existingGroupLabel: n.existingLabel }
            });
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
            const sample = await House.findOne({ group: g._id }).select('billingCycle rent');

            return {
                _id: g._id, label: g.label, prefix: g.prefix, padWidth: g.padWidth,
                colorIndex: g.colorIndex, count, nextSeq, nextName,
                billingCycle: sample?.billingCycle || 'monthly',
                rent: sample?.rent ?? null
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

        let finalBillingCycle = ['monthly', 'semester'].includes(req.body.billingCycle) ? req.body.billingCycle : null;
        if (!finalBillingCycle) {
            const sample = await House.findOne({ group: group._id }).select('billingCycle');
            finalBillingCycle = sample?.billingCycle || 'monthly';
        }

        let finalRent;
        if (finalBillingCycle === 'semester') {
            finalRent = Number(property.semesterRule?.rentAmount || 0);
            if (!finalRent || finalRent <= 0) {
                return res.status(400).json({ message: "Set the semester rent amount for this property before extending with semester-billed units." });
            }
        } else {
            finalRent = rentInput;
            if (!finalRent || finalRent <= 0) {
                const sample = await House.findOne({ group: group._id }).select('rent');
                finalRent = sample ? sample.rent : null;
            }
            if (!finalRent || finalRent <= 0) {
                return res.status(400).json({ message: 'A valid rent amount is required — could not infer one from this group' });
            }
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
        const existing = await House.find({ property: propertyId, name: { $in: names } })
            .select('name group')
            .populate('group', 'label prefix');
        if (existing.length) {
            const conflicts = existing.slice(0, 20).map(h => ({
                name:       h.name,
                groupLabel: h.group?.label || h.group?.prefix || 'Ungrouped'
            }));
            return res.status(400).json({
                message:        `${existing.length} name(s) already exist`,
                conflicts,
                totalConflicts: existing.length
            });
        }
 
        const docs = pairs.map(p => ({
            name: p.name, rent: finalRent, landlord: req.user.id, property: propertyId,
            group: group._id, groupSeq: p.seq, billingCycle: finalBillingCycle
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

        await HouseApplication.updateMany(
            { house: house._id, status: 'pending' },
            { status: 'cancelled', decisionNote: 'This house was removed', decidedAt: new Date() }
        );
        await House.findByIdAndDelete(req.params.id);
        res.json({ message: 'House deleted 🏡' });

    } catch (err) {
        res.status(500).json({ message: 'Error deleting house ❌' });
    }
});


// ═══════════════════════════════════════
// PAYMENT HELPER
// ═══════════════════════════════════════


async function getEffectiveRentForTenant(tenant, periodLabel = null) {
    if (!tenant || !tenant.house) return 0;

    const house = tenant.house;
    const cycle = (house.billingCycle || 'monthly').toLowerCase();

    if (cycle === 'semester') {
        const property = await Property.findById(tenant.property).select('semesterRule');
        if (!property) return Number(house.amountDue || house.rent || 0);

        const rule = normalizeSemesterRule(property.semesterRule || {});

        // A label that names a REAL semester (past/present/future) is honoured, so
        // Semester 1's balance is measured against Semester 1's rent. Anything else
        // (monthly labels, junk) falls back to the live window, as before.
        let window = periodLabel ? findSemesterWindowByLabel(rule, periodLabel) : null;
        if (!window) window = getSemesterWindowContaining(rule, new Date());
        const label = formatSemesterPeriodLabel(window);

        const billing = await Billing.findOne({
            landlord: tenant.landlord, tenant: tenant._id, house: house._id, periodLabel: label
        }).sort({ createdAt: -1 });

        if (billing && Number(billing.amountDue) > 0) return Number(billing.amountDue);
        if (window.rentAmount > 0) return window.rentAmount;
        if (Number(house.amountDue || 0) > 0) return Number(house.amountDue || 0);
    }

    // Monthly: a house transfer must never reprice history. A period up to and including the cycle the
    // transfer happened in keeps the rent of the house the tenant lived in then; the new house's rent
    // applies from the next cycle. Tenants with no transfers skip this block entirely.
    if (periodLabel && Array.isArray(tenant.houseHistory) && tenant.houseHistory.length) {
        const pIdx = monthIndexOfLabel(periodLabel);
        if (pIdx !== null) {
            const history = tenant.houseHistory
                .filter(h => h && h.lastPeriodStart && String(h.billingCycle || 'monthly') === 'monthly')
                .sort((a, b) => new Date(a.to) - new Date(b.to));
            for (const h of history) {
                if (pIdx <= monthIndexOfDate(h.lastPeriodStart)) return Number(h.rent || 0);
            }
        }
    }

    return Number(house.rent || 0);
}

async function getPeriodSummary(tenantId, periodLabel, rent, billingCycle = null) {
    const payments = await Payment.find({
        tenant: tenantId,
        $or: [
            { month: periodLabel },
            { periodLabel }
        ],
        category: 'rent',
        status: { $in: ['paid', 'partial'] }
    }).sort({ createdAt: 1 });

    const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const balance = Math.max(0, Number(rent || 0) - totalPaid);

    let status = 'unpaid';
    if (totalPaid >= Number(rent || 0)) status = 'paid';
    else if (totalPaid > 0) status = 'partial';

    return {
        rentAmount: Number(rent || 0),
        totalPaid,
        balance,
        status,
        billingCycle,
        payments
    };
}

async function getMonthSummary(tenantId, month, rent) {
    const payments = await Payment.find({
        tenant: tenantId,
        $or: [
            { month },
            { periodLabel: month }
        ],
        category: 'rent',
        status: { $in: ['paid', 'partial'] }
    }).sort({ createdAt: 1 });

    const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const balance = Math.max(0, Number(rent || 0) - totalPaid);

    let status = 'unpaid';
    if (totalPaid >= Number(rent || 0)) status = 'paid';
    else if (totalPaid > 0) status = 'partial';

    return {
        rentAmount: Number(rent || 0),
        totalPaid,
        balance,
        status,
        payments
    };
}


// ═══════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════

app.post('/payments', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        if (req.user.role === 'caretaker') {
            const caretakerCheck = await User.findById(req.user.id).select('caretakerPermissions');
            if (!caretakerCheck?.caretakerPermissions?.canRecordPayments) {
                return res.status(403).json({ message: 'You do not have permission to record payments' });
            }
        }

        const landlordScope = await resolveLandlordScope(req);
        const actorName = await getActorName(req);
        const tenantId = req.body.tenantId || '';
        const amount = Number(req.body.amount);
        let month = sanitize(req.body.month || '');
        const method = req.body.method || 'cash';
        const note = sanitize(req.body.note || '', 300);

        if (!tenantId || !amount || !month) {
            return res.status(400).json({ message: 'tenantId, amount and month are required' });
        }

        if (amount <= 0) {
            return res.status(400).json({ message: 'Amount must be greater than 0' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: landlordScope }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house assigned' });

        let semesterWindow = null;
        if ((tenant.house.billingCycle || 'monthly') === 'semester') {
            const property = await Property.findById(tenant.property).select('semesterRule');
            const rule   = normalizeSemesterRule(property?.semesterRule || {});
            let window   = getSemesterWindowContaining(rule, new Date());      // in a break: the next semester (early payment)
            // Between semesters / during an extension, money first settles whatever is still owed for the
            // semester the tenant is under; only once that is paid does it count towards the next one.
            if (rule.enabled) {
                const ctx = await getSemesterContext(rule, tenant, new Date());
                if (ctx.mode === 'between' || ctx.mode === 'extended') {
                    const prevLabel = formatSemesterPeriodLabel(ctx.window);
                    const prevRent  = await getEffectiveRentForTenant(tenant, prevLabel);
                    const prevSum   = await getPeriodSummary(tenant._id, prevLabel, prevRent, 'semester');
                    if (prevSum.balance > 0) window = ctx.window;
                }
            }
            semesterWindow = window;
            month = formatSemesterPeriodLabel(window); // overwrite whatever the client sent
        }

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned = (caretaker.properties || []).map(String).includes(String(tenant.property));
            if (!assigned) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
        }

        const rent = await getEffectiveRentForTenant(tenant, month);

        // The amount owed for a semester is frozen the moment the first payment is recorded, so a later change
        // to the property's default semester rent can never reprice a period that already has payments.
        if (semesterWindow) await freezeSemesterBilling(tenant, semesterWindow, month, rent);
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
        const newBalance = Math.max(0, rent - newTotalPaid);
        const newStatus = newBalance === 0 ? 'paid' : 'partial';

        const payment = await Payment.create({
            landlord: landlordScope,
            property: tenant.property,
            tenant: tenant._id,
            house: tenant.house._id,
            amount,
            billingCycle: tenant.house.billingCycle || 'monthly',
            month,
            periodLabel: month,
            category: 'rent',
            rentAmount: rent,
            totalPaid: newTotalPaid,
            balance: newBalance,
            status: newStatus,
            method,
            note,
            datePaid: new Date()
        });

        checkReferralQualification(landlordScope)
            .catch(err => console.error('Referral qualification check failed:', err.message));

        const emailCtx = await getEmailPeriodContext(tenant, month);

        const doc = new PDFDocument();
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

            sendRentReceiptEmail({
                tenant,
                house: tenant.house,
                month,
                amount,
                rent,
                newTotalPaid,
                newBalance,
                newStatus,
                paymentId: payment._id,
                pdfBuffer: pdfData,
                cycle:           emailCtx.cycle,
                periodRange:     emailCtx.periodRange,
                extensionCharge: emailCtx.extensionCharge
            }).catch(err => console.error('Receipt email failed:', err.message));

            logActivity({
                landlord: landlordScope,
                property: tenant.property,
                action: 'payment.recorded',
                message: `${tenant.name} paid Ksh ${Number(amount).toLocaleString()} for ${month}${actorName ? ` — recorded by ${actorName}` : ''}`,
                meta: { paymentId: payment._id, amount, method, status: newStatus, actorName },
                actor: actorName ? 'caretaker' : 'landlord'
            });

            res.json({
                message: `Payment recorded — ${newStatus.toUpperCase()} 📄`,
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

app.post('/payments/deposit', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const tenantId = req.body.tenantId || '';
        const amount   = Number(req.body.amount);
        const note     = sanitize(req.body.note || '', 300);

        if (!tenantId || !amount || amount <= 0) {
            return res.status(400).json({ message: 'tenantId and a valid amount are required' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: landlordScope });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const property = await Property.findOne({ _id: tenant.property, landlord: landlordScope });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const required = getRequiredDepositAmount(property);
        if (!required || required <= 0) {
            return res.status(400).json({ message: 'No deposit amount has been set for this property yet — set it under Semester & Deposit Rules.' });
        }

        // Deposit is a one-shot, all-or-nothing payment for the CURRENT
        // property — unlike rent, it never accumulates across multiple
        // transactions. If it's already satisfied for this property,
        // there is nothing left to collect.
        if (tenantHasValidDeposit(tenant, property)) {
            return res.status(400).json({
                message: `Deposit already paid in full for this property (Ksh ${required.toLocaleString()}).`
            });
        }

        // No partial deposits, ever — and no overpayment either. The
        // amount must match the required deposit exactly; anything else
        // is rejected outright rather than recorded as a running balance.
        // (Any legacy "partial" state predates this rule and is
        // superseded the moment a valid full payment is recorded below.)
        if (amount !== required) {
            return res.status(400).json({
                message: `Deposit must be paid in full — this property requires exactly Ksh ${required.toLocaleString()}.`,
                requiredAmount: required
            });
        }

        tenant.depositAmount          = amount;
        tenant.depositPaidForProperty = tenant.property;
        tenant.depositPaidAt          = new Date();
        tenant.depositStatus          = 'paid';
        await tenant.save();

        const payment = await Payment.create({
            landlord: landlordScope,
            property: tenant.property,
            tenant:   tenant._id,
            house:    tenant.house || null,
            amount,
            category: 'deposit',
            month:       sanitize(req.body.month || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }), 80),
            periodLabel: sanitize(req.body.periodLabel || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }), 80),
            rentAmount: 0,
            totalPaid:  amount,
            balance:    0,
            status:     'paid',
            method: req.body.method || 'cash',
            note,
            datePaid: new Date()
        });

        res.json({
            message: `Deposit recorded — Ksh ${required.toLocaleString()} paid in full ✅`,
            payment,
            depositStatus: 'paid',
            depositAmount: amount,
            requiredAmount: required
        });

    } catch (err) {
        console.error('Deposit payment error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


app.post('/payments/refund', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenantId = req.body.tenantId || '';
        const amount   = Number(req.body.amount);
        if (!tenantId || !amount) {
            return res.status(400).json({ message: 'tenantId and amount are required' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const payment = await Payment.create({
            landlord: req.user.id,
            property: tenant.property,
            tenant:   tenant._id,
            house:    tenant.house || null,
            amount,
            category: 'refund',
            month:       sanitize(req.body.month || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }), 80),
            periodLabel: sanitize(req.body.periodLabel || new Date().toLocaleString('default', { month: 'long', year: 'numeric' }), 80),
            rentAmount: 0, totalPaid: 0, balance: 0, status: 'paid',
            method: req.body.method || 'cash',
            note: sanitize(req.body.note || 'Deposit refund', 300),
            datePaid: new Date()
        });

        // Refunding always resets to "must pay again if re-added" — per
        // your spec, a refunded deposit is never carried forward.
        tenant.depositStatus = 'refunded';
        tenant.depositAmount = 0;
        await tenant.save();

        res.json({ message: 'Refund recorded — tenant will need to re-pay a deposit if reassigned', payment });
    } catch (err) {
        console.error('Refund payment error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Mid-semester move-out refund — distinct from the deposit refund above
//    via category:'refund' + refundContext:'rent'. Landlord-only, matching
//    the existing "only landlords can record refunds" convention. Must be
//    called BEFORE /move-out/:tenantId, since it needs tenant.house still
//    populated to compute the current period's rent/paid figures. ──
app.post('/payments/rent-refund', authMiddleware, landlordOnly, async (req, res) => {
    try {
        const tenantId = req.body.tenantId || '';
        const amount   = Number(req.body.amount);
        const note     = sanitize(req.body.note || 'Mid-semester move-out refund', 300);

        if (!tenantId || !amount || amount <= 0) {
            return res.status(400).json({ message: 'tenantId and a valid amount are required' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house assigned' });
        if ((tenant.house.billingCycle || 'monthly') !== 'semester') {
            return res.status(400).json({ message: 'This refund flow is for semester-billed tenants only' });
        }

        const property = await Property.findOne({ _id: tenant.property, landlord: req.user.id });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.status(400).json({ message: 'Semester billing is not configured for this property' });

        // Server-authoritative period — never trust a client-supplied label
        const window      = getSemesterWindowContaining(rule, new Date());
        const periodLabel = formatSemesterPeriodLabel(window);

        const rent    = await getEffectiveRentForTenant(tenant, periodLabel);
        const summary = await getPeriodSummary(tenant._id, periodLabel, rent, 'semester');

        if (amount > summary.totalPaid) {
            return res.status(400).json({
                message: `Refund cannot exceed the Ksh ${summary.totalPaid.toLocaleString()} actually collected for this period.`,
                totalPaid: summary.totalPaid
            });
        }

        const payment = await Payment.create({
            landlord: req.user.id,
            property: tenant.property,
            tenant:   tenant._id,
            house:    tenant.house._id,
            amount,
            category:      'refund',
            refundContext: 'rent',
            billingCycle:  'semester',
            month:       periodLabel,
            periodLabel,
            rentAmount: rent,
            totalPaid:  summary.totalPaid,
            balance:    summary.balance,
            status: 'paid',
            method: req.body.method || 'cash',
            note,
            datePaid: new Date()
        });

        // A refund can retroactively lower what a property owed for a month
        // whose commission has already been settled — reconcile immediately
        // rather than waiting for the next cycle to notice.
        await reconcileCommissionOverpayment(tenant.property, periodLabel);

        logActivity({
            landlord: req.user.id, property: tenant.property,
            action:   'payment.rent_refund',
            message:  `Ksh ${Number(amount).toLocaleString()} rent refund issued to ${tenant.name} for ${periodLabel}`,
            meta:     { paymentId: payment._id, tenantId: tenant._id, amount, periodLabel }
        });

        res.json({ message: 'Refund recorded ✅', payment, periodLabel });

    } catch (err) {
        console.error('POST /payments/rent-refund error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Preview shown to the landlord right before a mid-semester move-out —
//    tells the frontend whether the refund-choice step is even relevant. ──
app.get('/tenants/:id/semester-moveout-preview', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: landlordScope }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house assigned' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(tenant.property));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        if ((tenant.house.billingCycle || 'monthly') !== 'semester') {
            return res.json({ midSemester: false });
        }

        const property = await Property.findOne({ _id: tenant.property, landlord: landlordScope });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.json({ midSemester: false });

        const now    = new Date();
        const window = getSemesterWindowContaining(rule, now);
        if (now >= window.endDate) return res.json({ midSemester: false });

        const suggestion = await computeSemesterRefundSuggestion(tenant, property, now);
        if (!suggestion) return res.json({ midSemester: false });

        if (suggestion.totalPaid <= 0) return res.json({ midSemester: false });
        res.json({ midSemester: true, ...suggestion });

    } catch (err) {
        console.error('GET semester-moveout-preview error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

app.get('/payments', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope };

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        } else if (caretakerPropertyIds) {
            query.property = { $in: caretakerPropertyIds };
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
        let { tenantId, month } = req.params;

        if (req.user.role === 'tenant' && String(req.user.tenantId) !== tenantId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        if (req.user.role === 'landlord') {
            const tenant = await Tenant.findOne({ _id: tenantId, landlord: req.user.id });
            if (!tenant) return res.status(403).json({ message: 'Forbidden' });
        }

        const tenant = await Tenant.findById(tenantId).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (!tenant.house) return res.status(400).json({ message: 'Tenant has no house' });

        if ((tenant.house.billingCycle || 'monthly') === 'semester') {
            const property = await Property.findById(tenant.property).select('semesterRule');
            const rule   = normalizeSemesterRule(property?.semesterRule || {});
            const window = getSemesterWindowContaining(rule, new Date());
            month = formatSemesterPeriodLabel(window); // overwrite whatever the client sent
        }

        const periodRent = await getEffectiveRentForTenant(tenant, month);
        const summary = await getPeriodSummary(tenantId, month, periodRent, tenant.house.billingCycle || 'monthly');

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

        

        const months = await Payment.distinct('month', {
            tenant: tenantId,
            category: 'rent',                                   // FIX: don't pull deposit/refund months into rent history
            status: { $in: ['paid', 'partial'] }
        });

        const results = await Promise.all(
            months.map(async month => {
                const periodRent = await getEffectiveRentForTenant(tenant, month);  // FIX: effective rent computed per-period
                const s = await getMonthSummary(tenantId, month, periodRent);
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
app.get('/arrears', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope, status: 'active' };

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        } else if (caretakerPropertyIds) {
            query.property = { $in: caretakerPropertyIds };
        }

        const tenants = await Tenant.find(query).populate('house');
        const tenantsWithHouse = tenants.filter(t => t.house);
        const tenantIds = tenantsWithHouse.map(t => t._id);

        await settleGapHolds({ landlord: landlordScope });
        const holdMap = await getActiveHoldMap(tenantIds);

        // No month filter here — period keys differ per tenant, so we fetch
        // everything and group by the payment's own periodLabel/month.
        const payments = await Payment.find({
            tenant: { $in: tenantIds },
            category: 'rent',
            status: { $in: ['paid', 'partial'] }
        }).select('tenant amount month periodLabel');

        const paidMap = {};
        for (const p of payments) {
            const periodKey = p.periodLabel || p.month;
            paidMap[`${p.tenant}:${periodKey}`] = (paidMap[`${p.tenant}:${periodKey}`] || 0) + p.amount;
        }

        const propertyIds = [...new Set(tenantsWithHouse.map(t => String(t.property)))];
        const properties = await Property.find({ _id: { $in: propertyIds } }).select('semesterRule');
        const propertyMap = {};
        properties.forEach(p => { propertyMap[String(p._id)] = p; });

        const arrearsList = [];
        for (const tenant of tenantsWithHouse) {
            const cycle = (tenant.house.billingCycle || 'monthly').toLowerCase();
            let periodKey;

            if (cycle === 'semester') {
                const property = propertyMap[String(tenant.property)];
                const rule = normalizeSemesterRule(property?.semesterRule || {});
                if (!rule.enabled) continue;
                // The semester the tenant is under — a semester that has not started yet is not an arrear.
                const ctx = await getSemesterContext(rule, tenant, new Date());
                if (!ctx.started) continue;
                const window = ctx.window;
                if (holdExcludesWindow(holdMap.get(String(tenant._id)), window)) continue;
                periodKey = formatSemesterPeriodLabel(window);
            } else {
                // current rent cycle (anniversary from the assignment date; calendar month for legacy tenants)
                const mc = computeMonthlyCycle(tenant, new Date());
                // a cycle that began while the tenant was away on holiday is paused
                if (holdExcludesWindow(holdMap.get(String(tenant._id)), { startDate: mc.start, endDate: mc.end })) continue;
                periodKey = mc.key;
            }

            const rent = await getEffectiveRentForTenant(tenant, periodKey);
            const totalPaid = paidMap[`${tenant._id}:${periodKey}`] || 0;
            const balance = Math.max(0, rent - totalPaid);

            if (balance > 0) {
                arrearsList.push({
                    tenantId: tenant._id,
                    tenant: tenant.name,
                    email: tenant.email,
                    house: tenant.house.name,
                    month: periodKey,
                    billingCycle: cycle,
                    rent,
                    totalPaid,
                    balance,
                    status: totalPaid > 0 ? 'partial' : 'unpaid'
                });
            }
        }

        res.json(arrearsList);

    } catch (err) {
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

        const tenants = await Tenant.find(query).populate('house').populate('property', 'name');
        const monthlyTenants = tenants.filter(t => t.house && (t.house.billingCycle || 'monthly') === 'monthly');
        const tenantIds = monthlyTenants.map(t => t._id);

        const payments = await Payment.find({
            tenant: { $in: tenantIds },
            month,
            category: 'rent',                                  // FIX: exported "Paid" column must be rent only
            status: { $in: ['paid', 'partial'] }
        }).select('tenant amount');

        const paidMap = {};
        for (const p of payments) {
            const key = String(p.tenant);
            paidMap[key] = (paidMap[key] || 0) + p.amount;
        }

        const rows = [['Tenant', 'Email', 'Phone', 'Property', 'House', 'Billing Cycle', 'Rent', 'Paid', 'Balance', 'Status', 'Month']];

        for (const tenant of monthlyTenants) {
            const rent = await getEffectiveRentForTenant(tenant, month);
            const totalPaid = paidMap[String(tenant._id)] || 0;
            const balance   = Math.max(0, rent - totalPaid);
            if (balance <= 0) continue;

            rows.push([
                tenant.name, tenant.email, tenant.phone || '',
                tenant.property?.name || '', tenant.house.name, 'Monthly',
                rent, totalPaid, balance,
                totalPaid > 0 ? 'partial' : 'unpaid', month
            ]);
        }

        const semesterExcludedCount = tenants.filter(t => t.house && (t.house.billingCycle || 'monthly') === 'semester').length;
        if (semesterExcludedCount > 0) {
            rows.push([]);
            rows.push([`Note: ${semesterExcludedCount} semester-billed tenant(s) excluded — export "By Semester" from the Arrears page for those.`]);
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


// FIX Bug 15: batch arrears calculation for specific month too
app.get('/arrears/:month', authMiddleware, landlordOrCaretaker, async (req, res, next) => {
    try {
        const month = req.params.month;
        if (month === 'semester') return next('route');   // let /arrears/semester handle it
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope, status: 'active' };

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        } else if (caretakerPropertyIds) {
            query.property = { $in: caretakerPropertyIds };
        }

        const tenants = await Tenant.find(query).populate('house');
        const monthlyTenants = tenants.filter(t => t.house && (t.house.billingCycle || 'monthly') === 'monthly');
        const tenantIds = monthlyTenants.map(t => t._id);

        const payments = await Payment.find({
            tenant: { $in: tenantIds },
            month,
            category: 'rent',
            status: { $in: ['paid', 'partial'] }
        }).select('tenant amount');

        const paidMap = {};
        for (const p of payments) {
            const key = String(p.tenant);
            paidMap[key] = (paidMap[key] || 0) + p.amount;
        }

        const result = [];
        for (const tenant of monthlyTenants) {
            if (!tenant.house) continue;

            const rent = await getEffectiveRentForTenant(tenant, month);
            const totalPaid = paidMap[String(tenant._id)] || 0;
            const balance = Math.max(0, rent - totalPaid);

            if (balance > 0) {
                result.push({
                    tenantId: tenant._id,
                    tenant: tenant.name,
                    email: tenant.email,
                    house: tenant.house.name,
                    billingCycle: 'monthly',
                    month,
                    rent,
                    totalPaid,
                    balance,
                    status: totalPaid > 0 ? 'partial' : 'unpaid'
                });
            }
        }
                res.json(result);

            } catch (err) {
                res.status(500).json({ error: err.message });
            }
    });


    app.get('/arrears/semester', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const propertyId   = req.query.propertyId;
        const periodLabel  = sanitize(req.query.periodLabel || '');

        if (!propertyId)  return res.status(400).json({ message: 'propertyId is required' });
        if (!periodLabel) return res.status(400).json({ message: 'periodLabel is required' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(propertyId));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        const property = await Property.findOne({ _id: propertyId, landlord: landlordScope }).select('semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const tenants = await Tenant.find({ landlord: landlordScope, property: propertyId, status: 'active' }).populate('house');
        const semesterTenants = tenants.filter(t => t.house && (t.house.billingCycle || 'monthly') === 'semester');
        const tenantIds = semesterTenants.map(t => t._id);

        const semRule      = normalizeSemesterRule(property.semesterRule || {});
        const periodWindow = findSemesterWindowByLabel(semRule, periodLabel);
        const holdMap      = await getActiveHoldMap(tenantIds);

        const payments = await Payment.find({
            tenant: { $in: tenantIds },
            $or: [{ month: periodLabel }, { periodLabel }],
            category: 'rent',
            status: { $in: ['paid', 'partial'] }
        }).select('tenant amount');

        const paidMap = {};
        for (const p of payments) {
            const key = String(p.tenant);
            paidMap[key] = (paidMap[key] || 0) + p.amount;
        }

        const billings = await Billing.find({
            landlord: landlordScope, property: propertyId, periodLabel, tenant: { $in: tenantIds }
        }).select('tenant amountDue dueDateActual');
        const billingMap = {};
        billings.forEach(b => { billingMap[String(b.tenant)] = b; });

        const result = [];
        for (const tenant of semesterTenants) {
            if (periodWindow && holdExcludesWindow(holdMap.get(String(tenant._id)), periodWindow)) continue;
            const billing = billingMap[String(tenant._id)];
            let rent, estimated, dueDateActual;

            if (billing) {
                rent = billing.amountDue;
                estimated = false;
                dueDateActual = billing.dueDateActual;
            } else {
                rent = Number(periodWindow ? periodWindow.rentAmount : (tenant.house.rent || 0));
                estimated = true;
                dueDateActual = null;
            }

            const totalPaid = paidMap[String(tenant._id)] || 0;
            const balance = Math.max(0, rent - totalPaid);

            if (balance > 0) {
                result.push({
                    tenantId: tenant._id,
                    tenant: tenant.name,
                    email: tenant.email,
                    house: tenant.house.name,
                    month: periodLabel,
                    billingCycle: 'semester',
                    rent,
                    totalPaid,
                    balance,
                    estimated,
                    dueDateActual,
                    status: totalPaid > 0 ? 'partial' : 'unpaid'
                });
            }
        }

        res.json(result);

    } catch (err) {
        console.error('GET /arrears/semester error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


app.get('/semester-periods', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const propertyId = req.query.propertyId;
        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(propertyId));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        const property = await Property.findOne({ _id: propertyId, landlord: landlordScope }).select('semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.json({ periods: [] });

        const count         = Math.min(12, Math.max(1, parseInt(req.query.count) || 6));
        const now           = new Date();
        const currentWindow = getSemesterWindowContaining(rule, now);
        const currentLabel  = formatSemesterPeriodLabel(currentWindow);
        const currentAY     = currentWindow.academicYear;

        const all = [];
        for (let ay = currentAY - 4; ay <= currentAY + 1; ay++) all.push(...getAcademicYearWindows(rule, ay));

        const cutoff = Math.max(now.getTime(), currentWindow.startDate.getTime());
        const periods = all
            .filter(w => w.startDate.getTime() <= cutoff)
            .sort((a, b) => b.startDate - a.startDate)
            .slice(0, count)
            .map(w => {
                const label = formatSemesterPeriodLabel(w);
                return {
                    periodLabel:   label,
                    semesterLabel: w.semesterLabel,
                    startDate:     w.startDate,
                    endDate:       w.endDate,
                    dueDateActual: computeSemesterDueDate(w),
                    isCurrent:     label === currentLabel
                };
            });

        res.json({ periods });

    } catch (err) {
        console.error('GET /semester-periods error:', err.message);
        res.status(500).json({ message: err.message });
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

        const tenant = await Tenant.findById(req.user.tenantId).select('property landlord house name status');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (tenant.status !== 'active') {
            return res.status(403).json({ message: 'Your tenancy has ended — repair requests are closed.', code: 'TENANCY_ENDED' });
        }

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

        if (req.user.role === 'landlord' || req.user.role === 'caretaker') {
            const landlordScope = await resolveLandlordScope(req);
            query = { landlord: landlordScope };

            let caretakerPropertyIds = null;
            if (req.user.role === 'caretaker') {
                const caretaker = await User.findById(req.user.id).select('properties');
                caretakerPropertyIds = (caretaker.properties || []).map(String);
            }

            if (req.query.propertyId) {
                if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                    return res.status(403).json({ message: 'You are not assigned to this property' });
                }
                const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
                if (!property) return res.status(404).json({ message: 'Property not found' });
                query.property = req.query.propertyId;
            } else if (caretakerPropertyIds) {
                query.property = { $in: caretakerPropertyIds };
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

app.put('/maintenance-requests/:id/status', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        if (req.user.role === 'caretaker') {
            const caretakerCheck = await User.findById(req.user.id).select('caretakerPermissions');
            if (!caretakerCheck?.caretakerPermissions?.canManageMaintenance) {
                return res.status(403).json({ message: 'You do not have permission to manage maintenance requests' });
            }
        }

        const actorName = await getActorName(req);
        const { status, cost, resolutionNote } = req.body;
        const allowed = ['reported', 'in_progress', 'completed'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ message: `Status must be one of: ${allowed.join(', ')}` });
        }

        const landlordScope = await resolveLandlordScope(req);
        const request = await MaintenanceRequest.findOne({ _id: req.params.id, landlord: landlordScope })
            .populate('tenant', 'name');
        if (!request) return res.status(404).json({ message: 'Maintenance request not found' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(request.property));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        request.status = status;
        if (cost !== undefined && cost !== null && cost !== '') request.cost = Number(cost);
        if (typeof resolutionNote === 'string') request.resolutionNote = sanitize(resolutionNote, 500);
        if (status === 'completed' && !request.completedAt) request.completedAt = new Date();
        if (status !== 'completed') request.completedAt = null;

        await request.save();

        logActivity({
            landlord: landlordScope, property: request.property,
            action:   'maintenance.status_changed',
            message:  `${request.tenant?.name || 'Tenant'}'s ${request.category} request marked ${status}${actorName ? ` — by ${actorName}` : ''}`,
            meta:     { requestId: request._id, status, actorName },
            actor:    actorName ? 'caretaker' : 'landlord'
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

app.get('/activity', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope };

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        } else if (caretakerPropertyIds) {
            query.property = { $in: caretakerPropertyIds };
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
            _id: { $in: tenantIds },
            landlord: req.user.id,
            status: 'active'
        }).populate('house');

        if (!tenants.length) return res.status(404).json({ message: 'No matching active tenants found' });

        const bulkHoldMap  = await getActiveHoldMap(tenants.map(t => t._id));
        const now          = new Date();
        const semPropCache = {};
        let sent = 0, skipped = 0;

        for (const tenant of tenants) {
            if (!tenant.house) { skipped++; continue; }

            const isSemester = (tenant.house.billingCycle || 'monthly') === 'semester';
            const holds      = bulkHoldMap.get(String(tenant._id));
            let month;

            if (isSemester) {
                // The semester the tenant is actually under — same rule as the daily reminder job.
                const pk = String(tenant.property);
                if (!(pk in semPropCache)) semPropCache[pk] = await Property.findById(tenant.property).select('semesterRule');
                const rule = normalizeSemesterRule(semPropCache[pk]?.semesterRule || {});
                if (!rule.enabled) { skipped++; continue; }

                const sctx = await getSemesterContext(rule, tenant, now);
                if (!sctx.started) { skipped++; continue; }                          // not started yet → nothing owed
                if (holdExcludesWindow(holds, sctx.window)) { skipped++; continue; } // away on holiday → rent paused
                month = formatSemesterPeriodLabel(sctx.window);
            } else {
                // Monthly tenants are reminded about their CURRENT rent cycle.
                const cyc = computeMonthlyCycle(tenant, now);
                if (holdExcludesWindow(holds, { startDate: cyc.start, endDate: cyc.end })) { skipped++; continue; }
                month = cyc.key;
            }

            const effectiveRent = await getEffectiveRentForTenant(tenant, month);
            const summary       = await getMonthSummary(tenant._id, month, effectiveRent);
            if (summary.balance <= 0) { skipped++; continue; }

            const emailCtx = await getEmailPeriodContext(tenant, month);
            // "Overdue" only once the due date has actually passed; before that it is a "due soon" reminder.
            const overdue  = !!emailCtx.dueAt && dayDiff(now, emailCtx.dueAt) > 0;

            sendRentReminder({
                name:  tenant.name,
                email: tenant.email,
                house: tenant.house.name,
                rent:  effectiveRent,
                month,
                dueDate: emailCtx.dueDateText ? undefined : (emailCtx.dueAt ? emailCtx.dueAt.getDate() : (tenant.dueDate || undefined)),
                arrears: overdue ? summary.balance : undefined,
                balance: summary.balance,
                cycle:           emailCtx.cycle,
                periodRange:     emailCtx.periodRange,
                dueDateText:     emailCtx.dueDateText,
                extensionCharge: emailCtx.extensionCharge
            }).catch(err => console.error(`Bulk reminder failed for ${tenant.name}:`, err.message));

            sent++;
        }
        logActivity({
            landlord: req.user.id,
            action: 'tenants.bulk_reminded',
            message: `Sent ${sent} rent reminder${sent === 1 ? '' : 's'} manually`,
            meta: { sent, skipped, tenantIds }
        });

        res.json({
            message: `Reminders sent to ${sent} tenant(s)${skipped ? `, ${skipped} skipped (nothing owed, no house, or rent paused)` : ''}`,
            sent,
            skipped
        });

    } catch (err) {
        console.error('bulk-remind error:', err.message);
        res.status(500).json({ error: err.message });
    }
});



// ═══════════════════════════════════════
// SEMESTER STAY — extension, expected semesters, holiday holds
// ═══════════════════════════════════════

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d)   { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
// Whole days from b → a, calendar-day based (immune to time-of-day)
function dayDiff(a, b) { return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000); }
function toISODate(d) {
    if (!d) return null;
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function parseDateOnly(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d;
}

// Returns true (and has already sent the response) if a caretaker lacks the
// permission or isn't assigned to the property. Landlords always pass.
async function caretakerDenied(req, res, permKey, propertyId) {
    if (req.user.role !== 'caretaker') return false;
    const caretaker = await User.findById(req.user.id).select('properties caretakerPermissions');
    if (!caretaker) { res.status(404).json({ message: 'Caretaker not found' }); return true; }
    if (permKey && !caretaker.caretakerPermissions?.[permKey]) {
        res.status(403).json({ message: 'You do not have permission to do this' }); return true;
    }
    if (propertyId && !(caretaker.properties || []).map(String).includes(String(propertyId))) {
        res.status(403).json({ message: 'You are not assigned to this property' }); return true;
    }
    return false;
}

// ── Holiday-hold helpers ──
async function getActiveHoldMap(tenantIds) {
    if (!tenantIds || !tenantIds.length) return new Map();
    const holds = await HolidayHold.find({ tenant: { $in: tenantIds }, status: { $in: ['active', 'returned'] } })
        .select('tenant startDate status actualReturnDate kind autoEndDate').lean();
    const map = new Map();
    for (const h of holds) {
        const k = String(h.tenant);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(h);
    }
    return map;
}
// True when the tenant was away for the WHOLE semester (hold began on/before its first day and
// is still running, or ended after the semester finished). A hold that ended partway through a
// semester does NOT exclude it — the return route bills the remainder instead.
function holdExcludesWindow(holds, window) {
    if (!holds) return false;
    const list = Array.isArray(holds) ? holds : [holds];
    return list.some(h => {
        // A between-semesters hold only covers the gap itself — it never pauses a semester.
        if (h.kind === 'between_semesters') return false;
        if (new Date(h.startDate) > window.startDate) return false;
        if (h.status === 'active') return true;
        return !!h.actualReturnDate && new Date(h.actualReturnDate) > window.endDate;
    });
}
// Nights away × (monthly fee ÷ 30). Departure day counts, return day doesn't.
// While the hold is active it accrues up to today — so a late return simply keeps accruing.
function computeHoldAccrual(hold, asOf = new Date()) {
    // A between-semesters hold stops accruing on the day the next semester starts, even if the system
    // has not closed the record yet.
    const cap   = (hold.kind === 'between_semesters' && hold.status === 'active' && hold.autoEndDate) ? new Date(hold.autoEndDate) : null;
    const end   = hold.actualReturnDate || hold.endedAt || ((cap && asOf > cap) ? cap : asOf);
    const days  = Math.max(0, dayDiff(end, hold.startDate));
    const accrued = Math.ceil((Number(hold.feeAmount || 0) / 30) * days);
    return { days, accrued };
}
async function getHoldPaidMap(holdIds) {
    if (!holdIds.length) return {};
    const rows = await Payment.aggregate([
        { $match: { hold: { $in: holdIds }, category: 'holiday_hold', status: 'paid' } },
        { $group: { _id: '$hold', total: { $sum: '$amount' } } }
    ]);
    const map = {};
    rows.forEach(r => { map[String(r._id)] = r.total; });
    return map;
}
function formatHold(hold, paid = 0, asOf = new Date(), extra = {}) {
    const { days, accrued } = computeHoldAccrual(hold, asOf);
    const isActive    = hold.status === 'active';
    const overdueDays = isActive ? Math.max(0, dayDiff(asOf, hold.expectedReturnDate)) : 0;
    return {
        id:                String(hold._id),
        tenantId:          String(hold.tenant && hold.tenant._id ? hold.tenant._id : hold.tenant),
        status:            hold.status,
        startDateISO:      toISODate(hold.startDate),
        expectedReturnISO: toISODate(hold.expectedReturnDate),
        actualReturnISO:   hold.actualReturnDate ? toISODate(hold.actualReturnDate) : null,
        endedISO:          hold.endedAt ? toISODate(hold.endedAt) : null,
        feeAmount:         Number(hold.feeAmount || 0),
        daysAway:          days,
        accrued,
        paid,
        balance:           Math.max(0, accrued - paid),
        overdue:           overdueDays > 0,
        overdueDays,
        billingCycle:      hold.billingCycle || 'semester',
        kind:              hold.kind || 'holiday',
        autoEnded:         !!hold.autoEnded,
        ...extra
    };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// SEMESTER PERIOD CONTEXT · BETWEEN-SEMESTERS (GAP) HOLDS · TENANT-WIDE HOLIDAYS
// ═══════════════════════════════════════════════════════════════════════════════════════

function _dayAfter(d) { const x = startOfDay(d); return new Date(x.getFullYear(), x.getMonth(), x.getDate() + 1); }

function _allSemesterWindows(rule, now) {
    const safe = normalizeSemesterRule(rule);
    const y = now.getFullYear();
    const list = [];
    for (const ay of [y - 2, y - 1, y, y + 1]) list.push(...getAcademicYearWindows(safe, ay));
    return list.sort((a, b) => a.startDate - b.startDate);
}

// Which semester is this tenant "under" right now?
//   in        today is inside a semester                         → that semester
//   extended  the semester ended but a landlord extension still covers today → that semester
//   between   a semester ended, the next has not started, no extension      → the semester that just ended
//   upcoming  nothing has ended while the tenant was here (before the first semester, or they joined
//             during a gap)                                       → the next semester (not started yet)
// getSemesterWindowContaining() is untouched — it still returns the NEXT semester in a gap, which the
// tenant portal relies on for early payment. Everything that reports a tenant's balance uses this instead,
// so a semester that has not started yet can never show up as an arrear.
async function getSemesterContext(rule, tenant, now = new Date()) {
    const list       = _allSemesterWindows(rule, now);
    const containing = list.find(w => now >= w.startDate && now <= w.endDate);
    const nextOf     = w => list.find(x => x.startDate > w.startDate) || null;
    if (containing) return { mode: 'in', window: containing, next: nextOf(containing), started: true };

    const prev = [...list].reverse().find(w => w.endDate < now) || null;
    const next = list.find(w => w.startDate > now) || null;
    const joined = tenant && (tenant.assignedAt || tenant.createdAt) ? startOfDay(tenant.assignedAt || tenant.createdAt) : null;
    const wasHereWhenItEnded = !!prev && (!joined || joined <= startOfDay(prev.endDate));

    if (prev && wasHereWhenItEnded) {
        const houseId = tenant.house && (tenant.house._id || tenant.house);
        const billing = houseId
            ? await Billing.findOne({ landlord: tenant.landlord, tenant: tenant._id, house: houseId, periodLabel: formatSemesterPeriodLabel(prev) }).sort({ createdAt: -1 })
            : null;
        const extEnd = billing && billing.extendedEndDate ? new Date(billing.extendedEndDate) : null;
        if (extEnd && extEnd >= now) {
            return { mode: 'extended', window: prev, next, started: true, billing, effectiveEnd: extEnd };
        }
        const lastDay = extEnd && extEnd > prev.endDate ? extEnd : prev.endDate;     // the last day they were covered
        return {
            mode: 'between', window: prev, next, started: true, billing,
            gapStart: _dayAfter(lastDay), gapEnd: next ? startOfDay(next.startDate) : null
        };
    }
    return { mode: 'upcoming', window: next || list[list.length - 1], next, started: false };
}

// Has the landlord already dealt with this gap? (any hold that started inside it, or one still running)
function getGapStatus(ctx, holds, rule) {
    if (!ctx || ctx.mode !== 'between' || !ctx.next || !ctx.gapEnd || !(ctx.gapEnd > ctx.gapStart)) return null;
    const covering = (holds || []).find(h =>
        h.status === 'active' ||
        (startOfDay(h.startDate) >= ctx.gapStart && startOfDay(h.startDate) < ctx.gapEnd));
    return {
        prevLabel:      ctx.window.semesterLabel,
        nextLabel:      ctx.next.semesterLabel,
        gapStartISO:    toISODate(ctx.gapStart),
        nextStartISO:   toISODate(ctx.gapEnd),
        days:           dayDiff(ctx.gapEnd, ctx.gapStart),
        decisionNeeded: !covering,
        policy:         rule.gapPolicy || 'ask',
        defaultFee:     Number(rule.holdingFee || 0),
        coveredBy:      covering ? String(covering._id) : null
    };
}

function defaultHoldingFeeFor(property, cycle) {
    if (cycle === 'semester') return Number(normalizeSemesterRule(property?.semesterRule || {}).holdingFee || 0);
    const fee = Number(property?.monthlyHoldingFee);
    return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

// Closes between-semesters holds whose next semester has started. Idempotent and cheap.
async function settleGapHolds(extraFilter = {}) {
    try {
        const rows = await HolidayHold.find({
            kind: 'between_semesters', status: 'active', autoEndDate: { $lte: startOfDay(new Date()) }, ...extraFilter
        }).select('_id autoEndDate');
        for (const r of rows) {
            await HolidayHold.updateOne({ _id: r._id, status: 'active' }, { status: 'returned', actualReturnDate: r.autoEndDate, autoEnded: true });
        }
    } catch (err) { console.error('settleGapHolds failed:', err.message); }
}

// Tells the tenant (dashboard notification + email) what the landlord decided about their holding fee.
async function notifyTenantAboutHold({ tenant, property, hold, houseName }) {
    try {
        const fee      = Number(hold.feeAmount || 0);
        const perDay   = Math.ceil(fee / 30);
        const fmt      = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        const isGap    = hold.kind === 'between_semesters';
        const when     = isGap
            ? `between semesters (${fmt(hold.startDate)} to ${fmt(hold.expectedReturnDate)})`
            : `from ${fmt(hold.startDate)} until ${fmt(hold.expectedReturnDate)}`;
        const resumes  = isGap ? `Rent resumes when the next semester starts on ${fmt(hold.expectedReturnDate)}.`
                               : 'Your rent resumes when you are back.';
        const title = fee > 0 ? 'Holiday holding fee set' : 'Rent paused — no holding fee';
        const body  = fee > 0
            ? `Your landlord set a holding fee of Ksh ${fee.toLocaleString()} per month (about Ksh ${perDay.toLocaleString()} per day) to keep ${houseName || 'your room'} reserved ${when}. ${resumes}`
            : `Your landlord confirmed there is no holding fee for ${when}. ${houseName || 'Your room'} stays yours. ${resumes}`;

        await TenantNotification.create({
            landlord: tenant.landlord, property: tenant.property, tenant: tenant._id,
            type: 'holiday_fee', title, body,
            meta: { holdId: hold._id, feeAmount: fee, kind: hold.kind }
        });

        if (tenant.email) {
            sendHoldingFeeEmail({
                name: tenant.name, email: tenant.email, house: houseName, propertyName: property?.name,
                kind:       hold.kind || 'holiday',
                cycle:      hold.billingCycle || 'semester',
                feeAmount:  fee,
                startDate:  hold.startDate,
                returnDate: hold.expectedReturnDate
            }).catch(err => console.error('Holding-fee email failed:', err.message));
        }
    } catch (err) { console.error('notifyTenantAboutHold failed:', err.message); }
}

// Creates the hold for a gap (landlord decision or the property's gap policy) and tells the tenant.
async function createGapHold({ tenant, property, landlordScope, ctx, feeAmount, actorName = null, byPolicy = false }) {
    const houseId = tenant.house && (tenant.house._id || tenant.house);
    const hold = await HolidayHold.create({
        landlord: landlordScope, property: tenant.property, tenant: tenant._id, house: houseId,
        startDate: ctx.gapStart, expectedReturnDate: ctx.gapEnd, autoEndDate: ctx.gapEnd,
        feeAmount, kind: 'between_semesters', billingCycle: 'semester',
        note: `Between ${ctx.window.semesterLabel} and ${ctx.next.semesterLabel}`
    });
    const houseName = tenant.house && tenant.house.name;
    logActivity({
        landlord: landlordScope, property: tenant.property,
        action:   'holiday.gap_decided',
        message:  `${tenant.name}: ${feeAmount > 0 ? `holding fee Ksh ${feeAmount.toLocaleString()} / month` : 'no holding fee'} between ${ctx.window.semesterLabel} and ${ctx.next.semesterLabel}${byPolicy ? ' (property policy)' : actorName ? ` — by ${actorName}` : ''}`,
        meta:     { holdId: hold._id, tenantId: tenant._id, feeAmount, byPolicy },
        actor:    actorName ? 'caretaker' : (byPolicy ? 'system' : 'landlord')
    });
    await notifyTenantAboutHold({ tenant, property, hold, houseName });
    return hold;
}

// property.semesterRule.gapPolicy 'auto' / 'none': the decision is made for the landlord.
async function applyGapPolicyIfNeeded({ tenant, property, rule, ctx, holds }) {
    try {
        const gap = getGapStatus(ctx, holds, rule);
        if (!gap || !gap.decisionNeeded || gap.policy === 'ask') return null;
        const fee = gap.policy === 'auto' ? Number(rule.holdingFee || 0) : 0;
        return await createGapHold({ tenant, property, landlordScope: tenant.landlord, ctx, feeAmount: fee, byPolicy: true });
    } catch (err) {
        if (err && err.code !== 11000) console.error('applyGapPolicyIfNeeded failed:', err.message);
        return null;
    }
}

// Everything the tenant profile's "Current period" card needs, from ONE computation.
async function buildTenantPeriodSummary(tenant, property, holdDocs, now = new Date(), cur = null) {
    if (!tenant || tenant.status === 'moved_out' || !tenant.house) return null;
    const house = tenant.house;
    const cycle = String(house.billingCycle || 'monthly').toLowerCase();

    if (cycle === 'semester') {
        const rule = normalizeSemesterRule(property?.semesterRule || {});
        if (!rule.enabled) return null;
        const ctx   = (cur && cur.ctx) || await getSemesterContext(rule, tenant, now);
        const w     = ctx.window;
        const label = formatSemesterPeriodLabel(w);
        const billing = ctx.billing && ctx.mode !== 'in' && ctx.mode !== 'upcoming' ? ctx.billing
            : await Billing.findOne({ landlord: tenant.landlord, tenant: tenant._id, house: house._id, periodLabel: label }).sort({ createdAt: -1 });
        const total   = await getEffectiveRentForTenant(tenant, label);
        const summary = await getPeriodSummary(tenant._id, label, total, 'semester');
        const extensionCharge = Number(billing?.extensionCharge || 0);
        const effectiveEnd    = billing?.extendedEndDate || w.endDate;
        return {
            cycle: 'semester', label, semesterLabel: w.semesterLabel, mode: ctx.mode, started: ctx.started,
            startISO: toISODate(w.startDate), endISO: toISODate(w.endDate), effectiveEndISO: toISODate(effectiveEnd),
            dueISO: toISODate(computeSemesterDueDate(w)),
            rentBase: Math.max(0, total - extensionCharge), extensionCharge, extensionDays: Number(billing?.extensionDays || 0),
            totalDue: total, paid: summary.totalPaid, balance: summary.balance, status: summary.status,
            rentPaused: !!holdExcludesWindow(holdDocs, w),
            gap: getGapStatus(ctx, holdDocs, rule)
        };
    }

    const c       = computeMonthlyCycle(tenant, now);
    const rent    = await getEffectiveRentForTenant(tenant, c.key);
    const summary = await getMonthSummary(tenant._id, c.key, rent);
    return {
        cycle: 'monthly', label: c.key, semesterLabel: null, mode: c.mode, started: true,
        startISO: toISODate(c.start), endISO: toISODate(c.end), effectiveEndISO: toISODate(c.end),
        dueISO: toISODate(c.due), originalEndISO: toISODate(c.originalEnd), isOverride: c.isOverride,
        rentBase: rent, extensionCharge: 0, extensionDays: 0,
        totalDue: rent, paid: summary.totalPaid, balance: summary.balance, status: summary.status,
        rentPaused: !!holdExcludesWindow(holdDocs, { startDate: c.start, endDate: c.end }),
        gap: null
    };
}

// Creates the period's Billing record (amount = what the system charges right now) if it does not exist yet.
// Never overwrites an existing record, so a landlord's adjustment or an extension charge is untouched.
async function freezeSemesterBilling(tenant, window, periodLabel, amount) {
    try {
        if (!(Number(amount) > 0)) return;
        await Billing.findOneAndUpdate(
            { landlord: tenant.landlord, property: tenant.property, tenant: tenant._id, house: tenant.house._id, periodLabel },
            { $setOnInsert: {
                billingCycle: 'semester', amountDue: Number(amount), dueDate: window.dueDay,
                dueDateActual: computeSemesterDueDate(window), status: 'unpaid', paidAmount: 0
            } },
            { upsert: true, setDefaultsOnInsert: true }
        );
    } catch (err) {
        if (err.code !== 11000) console.error('freezeSemesterBilling failed:', err.message);
    }
}

// ── Everything the tenant profile's "Stay & Holiday" panel needs ──
app.get('/tenants/:id/stay-info', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: landlordScope }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (await caretakerDenied(req, res, null, tenant.property)) return;

        if (tenant.status !== 'active' || !tenant.house) {
            return res.json({ eligible: false });
        }

        // Monthly tenants only have the holiday part (no semesters, no extension charge here).
        if ((tenant.house.billingCycle || 'monthly') !== 'semester') {
            const mProp = await Property.findOne({ _id: tenant.property, landlord: landlordScope }).select('monthlyHoldingFee');
            const mHold = await HolidayHold.findOne({ tenant: tenant._id, status: 'active' });
            let hold = null;
            if (mHold) {
                const paidMap = await getHoldPaidMap([mHold._id]);
                hold = formatHold(mHold, paidMap[String(mHold._id)] || 0, new Date(), {
                    tenantName: tenant.name, houseName: tenant.house.name
                });
            }
            return res.json({
                eligible: true, cycle: 'monthly',
                tenantId: String(tenant._id), tenantName: tenant.name, houseName: tenant.house.name,
                hold, defaultHoldingFee: defaultHoldingFeeFor(mProp, 'monthly')
            });
        }

        const property = await Property.findOne({ _id: tenant.property, landlord: landlordScope }).select('semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });
        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.json({ eligible: false });

        const now         = new Date();
        await settleGapHolds({ tenant: tenant._id });
        const ay          = getCurrentAcademicYear(rule, now);
        const ctx         = await getSemesterContext(rule, tenant, now);   // the period the tenant is actually under
        const window      = ctx.window;
        const periodLabel = formatSemesterPeriodLabel(window);
        const nextWindow  = getNextSemesterWindow(rule, window);

        const billing = await Billing.findOne({
            landlord: landlordScope, tenant: tenant._id, house: tenant.house._id, periodLabel
        }).sort({ createdAt: -1 });
        const rent    = await getEffectiveRentForTenant(tenant, periodLabel);
        const summary = await getPeriodSummary(tenant._id, periodLabel, rent, 'semester');

        const totalDays    = semesterTotalDaysOf(window);
        const dailyRate    = window.rentAmount / totalDays;
        const effectiveEnd = billing?.extendedEndDate || window.endDate;

        const stay      = await TenantStay.findOne({ tenant: tenant._id }).lean();
        const staysFrom = tenant.assignedAt || tenant.createdAt || now;
        const semesters = ay.windows.map(w => ({
            sequence:      w.sequence,
            label:         w.semesterLabel,
            periodLabel:   formatSemesterPeriodLabel(w),
            startISO:      toISODate(w.startDate),
            endISO:        toISODate(w.endDate),
            // "completed" = the semester finished while this tenant was here
            completed:     w.endDate >= staysFrom && w.endDate < now
        }));
        const semestersCompleted   = semesters.filter(s => s.completed).length;
        const expected             = stay?.expectedSemesterCount || null;
        const academicYearComplete = !!expected && semestersCompleted >= expected;

        const activeHold = await HolidayHold.findOne({ tenant: tenant._id, status: 'active' });
        let hold = null;
        if (activeHold) {
            const paidMap = await getHoldPaidMap([activeHold._id]);
            hold = formatHold(activeHold, paidMap[String(activeHold._id)] || 0, now, {
                tenantName: tenant.name, houseName: tenant.house.name
            });
        }

        const holdsLean = await HolidayHold.find({ tenant: tenant._id, status: { $in: ['active', 'returned'] } })
            .select('status startDate kind').lean();
        const gap = getGapStatus(ctx, holdsLean, rule);
        // A gap hold closes itself when the next semester starts; if the tenant came back later the landlord can still say so.
        const ended = await HolidayHold.findOne({
            tenant: tenant._id, kind: 'between_semesters', autoEnded: true,
            autoEndDate: { $gte: new Date(now.getTime() - 45 * 86400000) }
        }).sort({ autoEndDate: -1 });
        let recentAutoEnded = null;
        if (ended) {
            const pm = await getHoldPaidMap([ended._id]);
            recentAutoEnded = formatHold(ended, pm[String(ended._id)] || 0, now, { tenantName: tenant.name, houseName: tenant.house.name });
        }

        res.json({
            eligible: true, cycle: 'semester',
            periodMode: ctx.mode, gap, recentAutoEnded,
            tenantId: String(tenant._id),
            tenantName: tenant.name,
            houseName: tenant.house.name,
            academicYear: ay.label,
            expectedSemesterCount: expected,
            semestersCompleted,
            academicYearComplete,
            semesters,
            semesterCountInYear: ay.windows.length,
            current: {
                periodLabel,
                semesterLabel:      window.semesterLabel,
                startISO:           toISODate(window.startDate),
                endISO:             toISODate(window.endDate),
                effectiveEndISO:    toISODate(effectiveEnd),
                extensionDays:      billing?.extensionDays || 0,
                extensionCharge:    billing?.extensionCharge || 0,
                rentAmount:         window.rentAmount,
                totalDays,
                dailyRate,
                amountDue:          rent,
                paid:               summary.totalPaid,
                balance:            summary.balance,
                nextSemesterStartISO: nextWindow ? toISODate(nextWindow.startDate) : null
            },
            hold,
            defaultHoldingFee: rule.holdingFee
        });

    } catch (err) {
        console.error('GET stay-info error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Expected number of semesters this tenant will stay this academic year ──
app.put('/tenants/:id/stay', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (await caretakerDenied(req, res, 'canManageTenants', tenant.property)) return;

        const count = Number(req.body.expectedSemesterCount);
        if (!Number.isInteger(count) || count < 1 || count > 3) {
            return res.status(400).json({ message: 'Expected semesters must be 1, 2 or 3' });
        }

        const property = await Property.findOne({ _id: tenant.property, landlord: landlordScope }).select('semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });
        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.status(400).json({ message: 'Semester billing is not enabled for this property' });
        if (count > rule.semesters.length) {
            return res.status(400).json({ message: `This property only has ${rule.semesters.length} semesters per academic year` });
        }

        const ay = getCurrentAcademicYear(rule, new Date());
        const stay = await TenantStay.findOneAndUpdate(
            { tenant: tenant._id },
            { landlord: landlordScope, property: tenant.property, expectedSemesterCount: count, academicYear: ay.label },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );

        res.json({ message: `Expected stay set to ${count} semester${count === 1 ? '' : 's'} ✅`, stay });

    } catch (err) {
        console.error('PUT tenant stay error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Extend a tenant's stay past the semester's normal end date. The extra
//    days are charged at the semester's DAILY RATE (default rent ÷ days in that
//    semester) — never another full semester. Landlord-only: it changes what
//    the tenant owes, same as "Set Period". ──
app.post('/tenants/:id/extend-stay', authMiddleware, landlordOnly, checkAccountStatus, async (req, res) => {
    try {
        const newEnd = parseDateOnly(req.body.newEndDate);
        if (!newEnd) return res.status(400).json({ message: 'A valid new end date is required (YYYY-MM-DD)' });

        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: req.user.id, status: 'active' }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Active tenant not found' });
        if (!tenant.house || (tenant.house.billingCycle || 'monthly') !== 'semester') {
            return res.status(400).json({ message: 'Only semester-billed tenants can have their stay extended' });
        }
        if (await HolidayHold.exists({ tenant: tenant._id, status: 'active' })) {
            return res.status(409).json({ message: 'This tenant is on holiday — record their return before extending their stay.' });
        }

        const property = await Property.findOne({ _id: tenant.property, landlord: req.user.id }).select('semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });
        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.status(400).json({ message: 'Semester billing is not enabled for this property' });

        // Same window as before while a semester is running; once it has ended, the semester being extended
        // (not the next one that has not started).
        const window = (await getSemesterContext(rule, tenant, new Date())).window;
        if (!(window.rentAmount > 0)) return res.status(400).json({ message: 'No semester rent is configured for this semester' });
        const periodLabel = formatSemesterPeriodLabel(window);

        const existing = await Billing.findOne({
            landlord: req.user.id, tenant: tenant._id, house: tenant.house._id, periodLabel
        }).sort({ createdAt: -1 });

        const currentEnd = existing?.extendedEndDate ? new Date(existing.extendedEndDate) : window.endDate;
        const extraDays  = dayDiff(newEnd, currentEnd);
        if (extraDays <= 0) {
            return res.status(400).json({ message: `The new end date must be after the current end date (${toISODate(currentEnd)}).` });
        }
        if (extraDays > 366) return res.status(400).json({ message: 'An extension cannot exceed 366 days' });

        const nextWindow = getNextSemesterWindow(rule, window);
        if (nextWindow && newEnd >= startOfDay(nextWindow.startDate)) {
            return res.status(400).json({
                message: `That date runs into ${nextWindow.semesterLabel}, which starts on ${toISODate(nextWindow.startDate)}. Choose an earlier date, or bill the next semester instead.`
            });
        }

        const baseRent     = await getEffectiveRentForTenant(tenant, periodLabel);
        const dailyRate    = window.rentAmount / semesterTotalDaysOf(window);
        const charge       = Math.ceil(dailyRate * extraDays);
        const newAmountDue = baseRent + charge;

        const filter = existing
            ? { _id: existing._id }
            : { landlord: req.user.id, property: tenant.property, tenant: tenant._id, house: tenant.house._id, periodLabel };

        const billing = await Billing.findOneAndUpdate(
            filter,
            {
                $set: { billingCycle: 'semester', amountDue: newAmountDue, extendedEndDate: endOfDay(newEnd) },
                $inc: { extensionDays: extraDays, extensionCharge: charge },
                $setOnInsert: { dueDate: window.dueDay, dueDateActual: computeSemesterDueDate(window), status: 'unpaid', paidAmount: 0 }
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );

        logActivity({
            landlord: req.user.id, property: tenant.property,
            action:   'stay.extended',
            message:  `${tenant.name}'s stay extended ${extraDays} day(s) to ${toISODate(newEnd)} — Ksh ${charge.toLocaleString()} added for ${periodLabel}`,
            meta:     { tenantId: tenant._id, periodLabel, extraDays, charge, newAmountDue }
        });

        res.json({
            message: `Stay extended by ${extraDays} day(s) — Ksh ${charge.toLocaleString()} added ✅`,
            periodLabel, extraDays, charge, newAmountDue, dailyRate,
            newEndISO: toISODate(newEnd), billing
        });

    } catch (err) {
        console.error('POST extend-stay error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Start a holiday (monthly AND semester tenants): the room stays reserved, rent for cycles that start
//    while the tenant is away is paused, and the holding fee begins. The landlord picks the fee:
//    feeMode 'default' (the property's default), 'custom' (feeAmount per month) or 'none'. ──
app.post('/tenants/:id/holiday', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: landlordScope }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (await caretakerDenied(req, res, 'canManageTenants', tenant.property)) return;

        if (tenant.status !== 'active') return res.status(400).json({ message: 'Only active tenants can go on holiday' });
        if (!tenant.house) return res.status(400).json({ message: 'This tenant has no house yet' });
        const holdCycle = (tenant.house.billingCycle || 'monthly') === 'semester' ? 'semester' : 'monthly';

        const property = await Property.findOne({ _id: tenant.property, landlord: landlordScope }).select('semesterRule name monthlyHoldingFee');
        if (!property) return res.status(404).json({ message: 'Property not found' });
        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (holdCycle === 'semester' && !rule.enabled) {
            return res.status(400).json({ message: 'Semester billing is not enabled for this property' });
        }

        const startDate          = parseDateOnly(req.body.startDate);
        const expectedReturnDate = parseDateOnly(req.body.expectedReturnDate);
        if (!startDate || !expectedReturnDate) {
            return res.status(400).json({ message: 'A valid start date and expected return date are required (YYYY-MM-DD)' });
        }
        const span = dayDiff(expectedReturnDate, startDate);
        if (span <= 0)   return res.status(400).json({ message: 'The expected return date must be after the holiday start date' });
        if (span > 366)  return res.status(400).json({ message: 'A holiday cannot be longer than 366 days' });
        if (dayDiff(startDate, new Date()) > 0) {
            return res.status(400).json({ message: 'The holiday start date cannot be in the future — record it on the day the tenant leaves' });
        }
        if (dayDiff(new Date(), startDate) > 120) {
            return res.status(400).json({ message: 'The start date cannot be more than 120 days ago' });
        }

        const defaultFee = defaultHoldingFeeFor(property, holdCycle);
        const feeRaw     = req.body.feeAmount;
        let feeAmount;
        if (req.body.feeMode === 'none')         feeAmount = 0;
        else if (req.body.feeMode === 'default') feeAmount = defaultFee;
        else feeAmount = (feeRaw === undefined || feeRaw === null || feeRaw === '') ? defaultFee : Number(feeRaw);
        if (req.body.feeMode === 'custom' && !(Number(feeRaw) > 0)) {
            return res.status(400).json({ message: 'Enter the holding fee per month, or choose "No fee"' });
        }
        if (!Number.isFinite(feeAmount) || feeAmount < 0) {
            return res.status(400).json({ message: 'Holding fee must be 0 or more' });
        }

        if (await HolidayHold.exists({ tenant: tenant._id, status: 'active' })) {
            return res.status(409).json({ message: 'This tenant is already on holiday' });
        }

        let hold;
        try {
            hold = await HolidayHold.create({
                landlord: landlordScope, property: tenant.property, tenant: tenant._id, house: tenant.house._id,
                startDate, expectedReturnDate, feeAmount, billingCycle: holdCycle, note: sanitize(req.body.note || '', 300)
            });
        } catch (err) {
            if (err.code === 11000) return res.status(409).json({ message: 'This tenant is already on holiday' });
            throw err;
        }

        const actorName = await getActorName(req);
        logActivity({
            landlord: landlordScope, property: tenant.property,
            action:   'holiday.started',
            message:  `${tenant.name} went on holiday (${toISODate(startDate)} → ${toISODate(expectedReturnDate)}) — room reserved${actorName ? ` — by ${actorName}` : ''}`,
            meta:     { holdId: hold._id, tenantId: tenant._id, feeAmount, actorName },
            actor:    actorName ? 'caretaker' : 'landlord'
        });

        await notifyTenantAboutHold({ tenant, property, hold, houseName: tenant.house.name });

        res.status(201).json({
            message: `${tenant.name} is now on holiday — room stays reserved ✅`,
            hold: formatHold(hold, 0, new Date(), { tenantName: tenant.name, houseName: tenant.house.name })
        });

    } catch (err) {
        console.error('POST holiday error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ═══════════════════════════════════════
// BETWEEN SEMESTERS — the landlord's holding-fee decision
// ═══════════════════════════════════════
// When a semester has ended and the next has not started, the tenant's rent is paused. For every such tenant
// the landlord chooses: the default holding fee, a custom fee per month, or no fee (or moves the tenant out
// through the normal move-out flow). Properties can pre-decide this with semesterRule.gapPolicy
// ('auto' = default fee, 'none' = no fee); with 'ask' (the default) the landlord is asked.

app.get('/gap-decisions', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope, 'semesterRule.enabled': true };

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties caretakerPermissions');
            if (!caretaker?.caretakerPermissions?.canManageTenants) return res.json({ count: 0, items: [] });
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }
        if (req.query.propertyId) {
            if (!/^[a-f0-9]{24}$/i.test(String(req.query.propertyId))) return res.status(400).json({ message: 'Invalid property' });
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            query._id = req.query.propertyId;
        } else if (caretakerPropertyIds) {
            query._id = { $in: caretakerPropertyIds };
        }

        const properties = await Property.find(query).select('name semesterRule');
        await settleGapHolds({ landlord: landlordScope });

        const now = new Date();
        const items = [];
        for (const property of properties) {
            const rule    = normalizeSemesterRule(property.semesterRule || {});
            const tenants = await Tenant.find({ landlord: landlordScope, property: property._id, status: 'active', house: { $ne: null } })
                .populate('house', 'name billingCycle');
            const semTenants = tenants.filter(t => t.house && (t.house.billingCycle || 'monthly') === 'semester');
            if (!semTenants.length) continue;

            const holds = await HolidayHold.find({ tenant: { $in: semTenants.map(t => t._id) }, status: { $in: ['active', 'returned'] } })
                .select('tenant status startDate kind').lean();
            const byTenant = new Map();
            for (const h of holds) {
                const k = String(h.tenant);
                if (!byTenant.has(k)) byTenant.set(k, []);
                byTenant.get(k).push(h);
            }

            for (const t of semTenants) {
                const ctx = await getSemesterContext(rule, t, now);
                if (ctx.mode !== 'between') continue;
                const tenantHolds = byTenant.get(String(t._id)) || [];
                if (rule.gapPolicy !== 'ask') {                     // pre-decided by the property's policy
                    await applyGapPolicyIfNeeded({ tenant: t, property, rule, ctx, holds: tenantHolds });
                    continue;
                }
                const gap = getGapStatus(ctx, tenantHolds, rule);
                if (gap && gap.decisionNeeded) {
                    items.push({
                        tenantId: String(t._id), tenantName: t.name, houseName: t.house.name,
                        propertyId: String(property._id), propertyName: property.name,
                        prevLabel: gap.prevLabel, nextLabel: gap.nextLabel,
                        gapStartISO: gap.gapStartISO, nextStartISO: gap.nextStartISO, days: gap.days,
                        defaultFee: gap.defaultFee
                    });
                }
            }
        }
        res.json({ count: items.length, items });

    } catch (err) {
        console.error('GET gap-decisions error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

app.post('/tenants/:id/gap-decision', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        if (!/^[a-f0-9]{24}$/i.test(String(req.params.id))) return res.status(404).json({ message: 'Tenant not found' });
        const tenant = await Tenant.findOne({ _id: req.params.id, landlord: landlordScope }).populate('house');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (await caretakerDenied(req, res, 'canManageTenants', tenant.property)) return;

        if (tenant.status !== 'active' || !tenant.house || (tenant.house.billingCycle || 'monthly') !== 'semester') {
            return res.status(400).json({ message: 'Only active semester-billed tenants have a break between semesters' });
        }
        const property = await Property.findOne({ _id: tenant.property, landlord: landlordScope }).select('name semesterRule');
        if (!property) return res.status(404).json({ message: 'Property not found' });
        const rule = normalizeSemesterRule(property.semesterRule || {});
        if (!rule.enabled) return res.status(400).json({ message: 'Semester billing is not enabled for this property' });

        await settleGapHolds({ tenant: tenant._id });
        const ctx   = await getSemesterContext(rule, tenant, new Date());
        const holds = await HolidayHold.find({ tenant: tenant._id, status: { $in: ['active', 'returned'] } }).select('status startDate kind').lean();
        const gap   = getGapStatus(ctx, holds, rule);
        if (!gap) return res.status(409).json({ message: 'This tenant is not between semesters right now' });
        if (!gap.decisionNeeded) return res.status(409).json({ message: 'A holding-fee decision has already been made for this break' });

        const choice = req.body.choice;
        let feeAmount;
        if (choice === 'default')      feeAmount = Number(rule.holdingFee || 0);
        else if (choice === 'none')    feeAmount = 0;
        else if (choice === 'custom') {
            feeAmount = Number(req.body.feeAmount);
            if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
                return res.status(400).json({ message: 'Enter the holding fee per month, or choose "No fee"' });
            }
        } else {
            return res.status(400).json({ message: 'Choose: default fee, custom fee or no fee' });
        }

        const actorName = await getActorName(req);
        let hold;
        try {
            hold = await createGapHold({ tenant, property, landlordScope, ctx, feeAmount, actorName });
        } catch (err) {
            if (err.code === 11000) return res.status(409).json({ message: 'A holding-fee decision has already been made for this break' });
            throw err;
        }

        res.status(201).json({
            message: feeAmount > 0
                ? `Holding fee of Ksh ${feeAmount.toLocaleString()} / month set until ${gap.nextLabel} starts on ${gap.nextStartISO} ✅`
                : `No holding fee until ${gap.nextLabel} starts on ${gap.nextStartISO} ✅`,
            hold: formatHold(hold, 0, new Date(), { tenantName: tenant.name, houseName: tenant.house.name })
        });

    } catch (err) {
        console.error('POST gap-decision error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ═══════════════════════════════════════
// TENANT DASHBOARD NOTIFICATIONS (a tenant only ever reads their own)
// ═══════════════════════════════════════
app.get('/tenant/me/notifications', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant' || !req.user.tenantId) return res.status(403).json({ message: 'Tenants only' });
        const [notifications, unreadCount] = await Promise.all([
            TenantNotification.find({ tenant: req.user.tenantId }).sort({ createdAt: -1 }).limit(20)
                .select('type title body createdAt readAt').lean(),
            TenantNotification.countDocuments({ tenant: req.user.tenantId, readAt: null })
        ]);
        res.json({ notifications, unreadCount });
    } catch (err) {
        console.error('GET tenant notifications error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

app.put('/tenant/me/notifications/read', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'tenant' || !req.user.tenantId) return res.status(403).json({ message: 'Tenants only' });
        const filter = { tenant: req.user.tenantId, readAt: null };
        if (req.body && req.body.id) {
            if (!/^[a-f0-9]{24}$/i.test(String(req.body.id))) return res.status(400).json({ message: 'Invalid notification' });
            filter._id = req.body.id;
        }
        await TenantNotification.updateMany(filter, { readAt: new Date() });
        res.json({ message: 'ok' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── Holiday holds list (active holds + any with an unpaid balance) ──
app.get('/holiday-holds', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope };

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            query.property = req.query.propertyId;
        } else if (caretakerPropertyIds) {
            query.property = { $in: caretakerPropertyIds };
        }

        const holds = await HolidayHold.find(query)
            .populate('tenant', 'name phone')
            .populate('house', 'name')
            .sort({ createdAt: -1 })
            .limit(300)
            .lean();

        const paidMap = await getHoldPaidMap(holds.map(h => h._id));
        const now = new Date();
        const out = holds
            .map(h => formatHold(h, paidMap[String(h._id)] || 0, now, {
                tenantName: h.tenant?.name || '—',
                houseName:  h.house?.name  || '—',
                propertyId: String(h.property)
            }))
            .filter(h => h.status === 'active' || h.balance > 0);

        res.json({ holds: out });

    } catch (err) {
        console.error('GET holiday-holds error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Tenant is back. Early / on time / late are all handled by the same
//    arithmetic: the fee accrues for the nights actually away. ──
app.put('/holiday-holds/:id/return', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const hold = await HolidayHold.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!hold) return res.status(404).json({ message: 'Holiday record not found' });
        if (await caretakerDenied(req, res, 'canManageTenants', hold.property)) return;
        // A between-semesters hold closes itself the day the next semester starts. If the tenant actually came
        // back LATER than that, the landlord can still record the real return date.
        const lateCorrection = hold.kind === 'between_semesters' && hold.autoEnded && hold.status === 'returned';
        if (hold.status !== 'active' && !lateCorrection) return res.status(400).json({ message: 'This holiday is already closed' });

        const returnDate = req.body.returnDate ? parseDateOnly(req.body.returnDate) : startOfDay(new Date());
        if (!returnDate) return res.status(400).json({ message: 'A valid return date is required (YYYY-MM-DD)' });
        if (dayDiff(returnDate, hold.startDate) < 0) {
            return res.status(400).json({ message: 'The return date cannot be before the holiday started' });
        }
        if (dayDiff(returnDate, new Date()) > 0) {
            return res.status(400).json({ message: 'The return date cannot be in the future — record the return on the day it happens' });
        }

        if (lateCorrection && !(dayDiff(returnDate, hold.autoEndDate) > 0)) {
            return res.status(400).json({ message: `A late return must be after ${toISODate(hold.autoEndDate)}, the day the next semester started` });
        }

        hold.status = 'returned';
        hold.actualReturnDate = returnDate;
        if (lateCorrection) hold.autoEnded = false;
        await hold.save();

        const tenant  = await Tenant.findById(hold.tenant).populate('house');
        const paidMap = await getHoldPaidMap([hold._id]);
        const formatted = formatHold(hold, paidMap[String(hold._id)] || 0, new Date(), { tenantName: tenant?.name || '—' });

        // Semester rent resumes from the return date. If they came back AFTER a semester they were
        // absent for had already started, bill only the remainder (the holding fee covered the rest).
        let proratedNote = '';
        try {
            if (tenant && tenant.status === 'active' && tenant.house && (tenant.house.billingCycle || 'monthly') === 'semester') {
                const property = await Property.findById(hold.property).select('semesterRule');
                const rule = normalizeSemesterRule(property?.semesterRule || {});
                if (rule.enabled) {
                    const window = getSemesterWindowContaining(rule, returnDate);
                    const awayForPartOfIt = new Date(hold.startDate) <= window.startDate
                        && returnDate > window.startDate && returnDate <= window.endDate;
                    if (awayForPartOfIt) {
                        const periodLabel = formatSemesterPeriodLabel(window);
                        const existing = await Billing.findOne({
                            landlord: landlordScope, tenant: tenant._id, house: tenant.house._id, periodLabel
                        });
                        if (!existing) {
                            const suggestion = await computeSemesterBillingSuggestion(tenant, property, returnDate, { lastReturnDate: returnDate });
                            if (suggestion && suggestion.amountDue < suggestion.rentAmount) {
                                await Billing.create({
                                    landlord: landlordScope, property: tenant.property, tenant: tenant._id, house: tenant.house._id,
                                    billingCycle: 'semester', periodLabel, amountDue: suggestion.amountDue,
                                    dueDate: window.dueDay, dueDateActual: suggestion.dueDateActual, status: 'unpaid', paidAmount: 0
                                });
                                proratedNote = ` ${window.semesterLabel} rent set to Ksh ${suggestion.amountDue.toLocaleString()} for the days after their return.`;
                            }
                        }
                    }
                }
            }
        } catch (e) { console.error('holiday-return proration error:', e.message); }

        // Monthly tenants: the rent cycle starts again on the day they are back (like a fresh assignment).
        let monthlyNote = '';
        try {
            if (tenant && tenant.status === 'active' && tenant.house && (tenant.house.billingCycle || 'monthly') === 'monthly') {
                tenant.cycleAnchor      = returnDate;
                tenant.cycleEndOverride = { date: null, cycleStart: null, originalEnd: null, setAt: null, setBy: null };
                await tenant.save();
                monthlyNote = ` Monthly rent restarts from ${toISODate(returnDate)}.`;
            }
        } catch (e) { console.error('holiday-return cycle restart error:', e.message); }

                // Tell the tenant they are recorded as back — fire-and-forget, never blocks the response.
        try {
            if (tenant && tenant.status === 'active' && tenant.email) {
                const retProp = await Property.findById(hold.property).select('name');
                sendHolidayReturnEmail({
                    name:         tenant.name,
                    email:        tenant.email,
                    house:        tenant.house ? tenant.house.name : '',
                    propertyName: retProp ? retProp.name : '',
                    cycle:        hold.billingCycle || 'semester',
                    startDate:    hold.startDate,
                    returnDate:   hold.actualReturnDate,
                    daysAway:     formatted.daysAway,
                    feeAmount:    hold.feeAmount,
                    accrued:      formatted.accrued,
                    balance:      formatted.balance
                }).catch(err => console.error('Holiday return email failed:', err.message));
            }
        } catch (e) { console.error('holiday-return email error:', e.message); }

        const offset = dayDiff(returnDate, hold.expectedReturnDate); // <0 early, >0 late
        const timing = offset < 0 ? `${Math.abs(offset)} day(s) early` : offset > 0 ? `${offset} day(s) late` : 'on the expected date';

        const actorName = await getActorName(req);
        logActivity({
            landlord: landlordScope, property: hold.property,
            action:   'holiday.returned',
            message:  `${tenant?.name || 'Tenant'} returned from holiday ${timing} — holding fee Ksh ${formatted.accrued.toLocaleString()}${actorName ? ` — by ${actorName}` : ''}`,
            meta:     { holdId: hold._id, offset, accrued: formatted.accrued, actorName },
            actor:    actorName ? 'caretaker' : 'landlord'
        });

        res.json({
            message: `Welcome back — returned ${timing}. Holding fee: Ksh ${formatted.accrued.toLocaleString()} (balance Ksh ${formatted.balance.toLocaleString()}).${proratedNote}${monthlyNote}`,
            hold: formatted
        });

    } catch (err) {
        console.error('PUT holiday return error:', err.message);
        res.status(500).json({ message: err.message });
    }
});

// ── Change the expected return date of an active holiday (the fee is NOT
//    editable after the fact — it's snapshotted so accrued fees never reprice) ──
app.put('/holiday-holds/:id', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const hold = await HolidayHold.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!hold) return res.status(404).json({ message: 'Holiday record not found' });
        if (await caretakerDenied(req, res, 'canManageTenants', hold.property)) return;
        if (hold.status !== 'active') return res.status(400).json({ message: 'Only an active holiday can be edited' });

        const expectedReturnDate = parseDateOnly(req.body.expectedReturnDate);
        if (!expectedReturnDate) return res.status(400).json({ message: 'A valid expected return date is required (YYYY-MM-DD)' });
        if (dayDiff(expectedReturnDate, hold.startDate) <= 0) {
            return res.status(400).json({ message: 'The expected return date must be after the holiday start date' });
        }
        hold.expectedReturnDate = expectedReturnDate;
        await hold.save();

        res.json({ message: 'Expected return date updated ✅' });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ── Record a holding-fee payment. Capped at what has accrued — no prepayment,
//    so the ledger can never show a credit the tenant hasn't earned yet. ──
app.post('/holiday-holds/:id/payments', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const hold = await HolidayHold.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!hold) return res.status(404).json({ message: 'Holiday record not found' });
        if (await caretakerDenied(req, res, 'canRecordPayments', hold.property)) return;

        const amount = Number(req.body.amount);
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Enter a valid amount' });
        const method = ['cash', 'mpesa', 'bank', 'other'].includes(req.body.method) ? req.body.method : 'cash';

        const paidMap = await getHoldPaidMap([hold._id]);
        const paid    = paidMap[String(hold._id)] || 0;
        const { accrued } = computeHoldAccrual(hold);
        const balance = accrued - paid;

        if (balance <= 0) return res.status(400).json({ message: 'Nothing is owed on this holiday hold right now' });
        if (amount > balance) return res.status(400).json({ message: `Amount exceeds the balance of Ksh ${balance.toLocaleString()}`, balance });

        const tenant = await Tenant.findById(hold.tenant).select('name');
        const monthLabel = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

        const payment = await Payment.create({
            landlord: landlordScope, property: hold.property, tenant: hold.tenant, house: hold.house || null,
            amount, category: 'holiday_hold', hold: hold._id,
            month: monthLabel, periodLabel: monthLabel,
            rentAmount: accrued, totalPaid: paid + amount, balance: Math.max(0, accrued - paid - amount),
            status: 'paid', method, note: sanitize(req.body.note || 'Holiday holding fee', 300), datePaid: new Date()
        });

        const actorName = await getActorName(req);
        logActivity({
            landlord: landlordScope, property: hold.property,
            action:   'holiday.fee_paid',
            message:  `${tenant?.name || 'Tenant'} paid Ksh ${amount.toLocaleString()} holiday holding fee${actorName ? ` — recorded by ${actorName}` : ''}`,
            meta:     { holdId: hold._id, paymentId: payment._id, amount, actorName },
            actor:    actorName ? 'caretaker' : 'landlord'
        });

        res.json({ message: `Holding fee of Ksh ${amount.toLocaleString()} recorded ✅`, payment, balance: Math.max(0, balance - amount) });

    } catch (err) {
        console.error('POST hold payment error:', err.message);
        res.status(500).json({ message: err.message });
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
        let month  = sanitize(req.body.month || '');

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
        if (tenant.status !== 'active') {
            return res.status(403).json({ message: 'Your tenancy has ended — rent payments are closed.', code: 'TENANCY_ENDED' });
        }
        if (!tenant.phone) return res.status(400).json({ message: 'No phone number on your account' });
        if (!tenant.house) return res.status(400).json({ message: 'No house assigned — contact your landlord' });

        if ((tenant.house.billingCycle || 'monthly') === 'semester') {
            const property = await Property.findById(tenant.property).select('semesterRule');
            const rule   = normalizeSemesterRule(property?.semesterRule || {});
            const window = getSemesterWindowContaining(rule, new Date());
            month = formatSemesterPeriodLabel(window);

            // Same rule the landlord side uses: a semester that starts while the
            // tenant is on a holiday hold owes no rent — only the holding fee applies.
            const holdMap = await getActiveHoldMap([tenant._id]);
            if (holdExcludesWindow(holdMap.get(String(tenant._id)), window)) {
                return res.status(400).json({
                    message: 'Rent for this semester is paused while you are on holiday.',
                    code:    'RENT_PAUSED'
                });
            }
        }

        const property = await Property.findById(tenant.property);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        if (!property.paymentConfigured || !property.mpesaConsumerKey) {
            return res.status(400).json({
                message: 'Your landlord has not configured M-Pesa payments for this property yet.',
                code:    'PAYMENT_NOT_CONFIGURED'
            });
        }

        // AFTER
        const rent    = await getEffectiveRentForTenant(tenant, month);   // FIX: respects semester Billing/amountDue
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
                TransactionType:   property.mpesaAccountType === 'till'
                                ? 'CustomerBuyGoodsOnline'
                                : 'CustomerPayBillOnline',
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
            billingCycle: tenant.house.billingCycle || 'monthly',
            month,
            category:          'rent',
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

            // AFTER
            // FIX: recompute effective rent (handles semester billing) instead of trusting
            // whatever was stored at STK-push time or the raw house.rent field.
            const effectiveTenantForCallback = {
                landlord: payment.landlord,
                property: payment.property,
                _id:      payment.tenant._id,
                house:    payment.house
            };
            const rent        = await getEffectiveRentForTenant(effectiveTenantForCallback, payment.month);
            const previousAgg = await Payment.aggregate([
                {
                    $match: {
                        tenant: payment.tenant._id,
                        month:  payment.month,
                        category: 'rent', // FIX: don't let a refund/deposit skew the running total
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

            // Fire-and-forget — a webhook callback must never be slowed down or fail on this.
            checkReferralQualification(payment.landlord)
                .catch(err => console.error('Referral qualification check failed:', err.message));

            if (payment.tenant?.email) {
                const emailCtx = await getEmailPeriodContext(
                    { ...payment.tenant.toObject(), house: payment.house }, payment.month
                );
                sendMpesaConfirmationEmail({
                    tenant:          payment.tenant,
                    house:           payment.house,
                    payment,
                    mpesaCode,
                    newTotalPaid,
                    newBalance,
                    newStatus,
                    cycle:           emailCtx.cycle || payment.billingCycle,
                    periodRange:     emailCtx.periodRange,
                    extensionCharge: emailCtx.extensionCharge
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

        const category = payment.category || 'rent';
        const titles = {
            rent:         'RENT RECEIPT',
            deposit:      'DEPOSIT RECEIPT',
            refund:       'REFUND RECEIPT',
            holiday_hold: 'HOLIDAY HOLDING FEE RECEIPT'
        };
        const ksh = n => `Ksh ${Number(n || 0).toLocaleString()}`;

        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=receipt-${payment._id}.pdf`);

        doc.pipe(res);
        doc.fontSize(20).text(titles[category] || 'RECEIPT', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Tenant:      ${payment.tenant?.name || '—'}`);
        doc.text(`House:       ${payment.house?.name || '—'}`);

        if (category === 'rent') {
            doc.text(`Amount Paid: ${ksh(payment.amount)}`);
            doc.text(`Total Paid:  ${ksh(payment.totalPaid || payment.amount)}`);
            doc.text(`Balance:     ${ksh(payment.balance)}`);
            doc.text(`Month:       ${payment.month}`);
            doc.text(`Status:      ${(payment.status || 'paid').toUpperCase()}`);
        } else if (category === 'deposit') {
            doc.text(`Deposit Paid: ${ksh(payment.amount)}`);
            doc.text(`Status:       ${(payment.status || 'paid').toUpperCase()}`);
        } else if (category === 'refund') {
            doc.text(`Amount Refunded: ${ksh(payment.amount)}`);
            doc.text(`Refund Of:       ${payment.refundContext === 'rent' ? `Semester rent (${payment.month})` : 'Security deposit'}`);
        } else if (category === 'holiday_hold') {
            doc.text(`Fee Paid:        ${ksh(payment.amount)}`);
            doc.text(`Total Fees Paid: ${ksh(payment.totalPaid)}`);
            doc.text(`Balance:         ${ksh(payment.balance)}`);
        }

        doc.text(`Method:      ${payment.method || 'cash'}`);
        doc.text(`Date:        ${new Date(payment.datePaid || payment.createdAt).toDateString()}`);
        doc.text(`Receipt ID:  ${payment._id}`);
        if (payment.note) doc.text(`Note:        ${payment.note}`);
        doc.moveDown();
        doc.text('Thank you — Affordable Rentals');
        doc.end();

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════

// FIX Bug 15: batch payment aggregation instead of N+1 getMonthSummary calls
app.get('/dashboard/:month', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const month          = req.params.month;
        const landlordScope  = await resolveLandlordScope(req);
        const tenantQuery    = { landlord: landlordScope, status: 'active' };
        const houseQuery     = { landlord: landlordScope };
        const expenseQuery   = { landlord: new mongoose.Types.ObjectId(landlordScope), month };
        const maintQuery     = { landlord: landlordScope, status: { $in: ['reported', 'in_progress'] } };
        let   propertyInfo   = null;
        let   propertyDoc    = null;

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            tenantQuery.property  = req.query.propertyId;
            houseQuery.property   = req.query.propertyId;
            expenseQuery.property = new mongoose.Types.ObjectId(req.query.propertyId);
            maintQuery.property   = req.query.propertyId;
            propertyInfo = { id: property._id, name: property.name, location: property.location };
            propertyDoc  = property;
        } else if (caretakerPropertyIds) {
            tenantQuery.property  = { $in: caretakerPropertyIds };
            houseQuery.property   = { $in: caretakerPropertyIds };
            expenseQuery.property = { $in: caretakerPropertyIds.map(id => new mongoose.Types.ObjectId(id)) };
            maintQuery.property   = { $in: caretakerPropertyIds };
        }

        const tenants = await Tenant.find(tenantQuery).populate('house');
        const houses  = await House.find(houseQuery);

        let occupied = 0;
        houses.forEach(h => { if (h.status === 'occupied') occupied++; });

        const monthlyTenants  = tenants.filter(t => t.house && (t.house.billingCycle || 'monthly') === 'monthly');
        const semesterTenants = tenants.filter(t => t.house && (t.house.billingCycle || 'monthly') === 'semester');

        // ── Income is drawn straight from Payment records, independent of
        //    whether the paying tenant is still active — a move-out must
        //    never retroactively erase money that was actually collected. ──
        const paymentMatchBase = { landlord: new mongoose.Types.ObjectId(landlordScope), category: 'rent', status: { $in: ['paid', 'partial'] } };
        const holdMap = await getActiveHoldMap(semesterTenants.map(t => t._id));
        if (req.query.propertyId) {
            paymentMatchBase.property = new mongoose.Types.ObjectId(req.query.propertyId);
        } else if (caretakerPropertyIds) {
            paymentMatchBase.property = { $in: caretakerPropertyIds.map(id => new mongoose.Types.ObjectId(id)) };
        }



        const monthlyIncomeAgg = await Payment.aggregate([
            { $match: { ...paymentMatchBase, billingCycle: 'monthly', month } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const monthlyIncome = monthlyIncomeAgg[0]?.total || 0;

        // ── Arrears still only concern currently active tenants — a
        //    moved-out tenant is no longer "owing" in the live sense. ──
        const monthlyPaymentsAgg = await Payment.aggregate([
            { $match: { tenant: { $in: monthlyTenants.map(t => t._id) }, month, category: 'rent', status: { $in: ['paid', 'partial'] } } },
            { $group: { _id: '$tenant', totalPaid: { $sum: '$amount' } } }
        ]);
        const monthlyPaidMap = {};
        monthlyPaymentsAgg.forEach(p => { monthlyPaidMap[String(p._id)] = p.totalPaid; });

        let monthlyArrears = 0;
        // A tenant who went on holiday before this month began owes no rent for it (the holding fee applies instead).
        const monthlyHoldMap = await getActiveHoldMap(monthlyTenants.map(t => t._id));
        const selMonthStart  = new Date('1 ' + month);
        const selMonthEnd    = isNaN(selMonthStart.getTime()) ? null : new Date(selMonthStart.getFullYear(), selMonthStart.getMonth() + 1, 0, 23, 59, 59, 999);
        for (const tenant of monthlyTenants) {
            if (selMonthEnd && holdExcludesWindow(monthlyHoldMap.get(String(tenant._id)), { startDate: selMonthStart, endDate: selMonthEnd })) continue;
            const rent      = await getEffectiveRentForTenant(tenant, month);
            const totalPaid = monthlyPaidMap[String(tenant._id)] || 0;
            monthlyArrears += Math.max(0, rent - totalPaid);
        }

        // ── Semester income/arrears — always the LIVE window, independent
        //    of whichever calendar month the dashboard selector shows ──
        let semesterIncome = 0, semesterArrears = 0, semesterSnapshot = null;

        if (semesterTenants.length && propertyDoc) {
            const rule = normalizeSemesterRule(propertyDoc.semesterRule || {});
            if (rule.enabled) {
                const window      = getSemesterWindowContaining(rule, new Date());
                const periodLabel = formatSemesterPeriodLabel(window);

                // Tenants on a holiday hold that began before this semester owe no rent for it
                const billableSemesterTenants = semesterTenants.filter(t => !holdExcludesWindow(holdMap.get(String(t._id)), window));
                const semesterTenantIds = billableSemesterTenants.map(t => t._id);

                const semesterIncomeAgg = await Payment.aggregate([
                    { $match: { ...paymentMatchBase, billingCycle: 'semester', $or: [{ month: periodLabel }, { periodLabel }] } },
                    { $group: { _id: null, total: { $sum: '$amount' } } }
                ]);
                const semesterRentCollected = semesterIncomeAgg[0]?.total || 0;

                const semesterRefundAgg = await Payment.aggregate([
                    { $match: { ...paymentMatchBase, category: 'refund', refundContext: 'rent', billingCycle: 'semester', $or: [{ month: periodLabel }, { periodLabel }] } },
                    { $group: { _id: null, total: { $sum: '$amount' } } }
                ]);
                const semesterRentRefunded = semesterRefundAgg[0]?.total || 0;

                semesterIncome = Math.max(0, semesterRentCollected - semesterRentRefunded);

                const semesterPaymentsAgg = await Payment.aggregate([
                    { $match: { tenant: { $in: semesterTenantIds }, $or: [{ month: periodLabel }, { periodLabel }], category: 'rent', status: { $in: ['paid', 'partial'] } } },
                    { $group: { _id: '$tenant', totalPaid: { $sum: '$amount' } } }
                ]);
                const semesterPaidMap = {};
                semesterPaymentsAgg.forEach(p => { semesterPaidMap[String(p._id)] = p.totalPaid; });

                let semesterTotalDue = 0;
                const semesterStarted = window.startDate <= new Date();       // an upcoming semester is not an arrear yet
                for (const tenant of billableSemesterTenants) {
                    const rent      = await getEffectiveRentForTenant(tenant, periodLabel);
                    const totalPaid = semesterPaidMap[String(tenant._id)] || 0;
                    if (semesterStarted) semesterArrears += Math.max(0, rent - totalPaid);
                    semesterTotalDue += rent;
                }
                const dueDateActual = computeSemesterDueDate(window);
                const daysRemaining = Math.ceil((dueDateActual.getTime() - Date.now()) / 86400000);

                semesterSnapshot = {
                    periodLabel, tenantCount: billableSemesterTenants.length,
                    totalCollected: semesterIncome, totalDue: semesterTotalDue,
                    dueDateActual, daysRemaining
                };
            }
        }

        // Holiday holding fees collected this calendar month (no commission is charged on
        // these — computeCommissionForProperty only ever counts category:'rent')
        const holidayHoldIncomeAgg = await Payment.aggregate([
            { $match: { ...paymentMatchBase, category: 'holiday_hold', month } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const holidayHoldIncome = holidayHoldIncomeAgg[0]?.total || 0;

        const totalIncome  = monthlyIncome + semesterIncome + holidayHoldIncome;
        const totalArrears = monthlyArrears + semesterArrears;

        // ── Upcoming semester dues — across all semester tenants in scope,
        //    due within 14 days, still carrying a balance ──
        let upcomingSemesterDueCount = 0;
        if (semesterTenants.length) {
            const semPropertyIds = [...new Set(semesterTenants.map(t => String(t.property)))];
            const semProperties  = await Property.find({ _id: { $in: semPropertyIds } }).select('semesterRule');
            const semPropertyMap = {};
            semProperties.forEach(p => { semPropertyMap[String(p._id)] = p; });
            const in14Days = Date.now() + 14 * 86400000;

            for (const tenant of semesterTenants) {
                const prop = semPropertyMap[String(tenant.property)];
                const rule = normalizeSemesterRule(prop?.semesterRule || {});
                if (!rule.enabled) continue;
                const window = getSemesterWindowContaining(rule, new Date());
                const dueDateActual = computeSemesterDueDate(window);
                 if (holdExcludesWindow(holdMap.get(String(tenant._id)), window)) continue;
                if (dueDateActual.getTime() > in14Days) continue;
                if (dueDateActual.getTime() < Date.now() - 86400000) continue;

                const periodLabel = formatSemesterPeriodLabel(window);
                const rent = await getEffectiveRentForTenant(tenant, periodLabel);
                const paidAgg = await Payment.aggregate([
                    { $match: { tenant: tenant._id, $or: [{ month: periodLabel }, { periodLabel }], category: 'rent', status: { $in: ['paid', 'partial'] } } },
                    { $group: { _id: null, total: { $sum: '$amount' } } }
                ]);
                const paid = paidAgg[0]?.total || 0;
                if (rent - paid > 0) upcomingSemesterDueCount++;
            }
        }

        const expensesAgg = await Expense.aggregate([
            { $match: expenseQuery },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const totalExpenses = expensesAgg[0]?.total || 0;
        const openMaintenanceCount = await MaintenanceRequest.countDocuments(maintQuery);
        const landlord = await User.findById(landlordScope).select('name propertyName propertyLocation paymentConfigured accountStatus');

        res.json({
            month, totalIncome, totalArrears,
            monthlyIncome, monthlyArrears, semesterIncome, semesterArrears, holidayHoldIncome,
            semesterSnapshot, upcomingSemesterDueCount,
            totalExpenses, netIncome: totalIncome - totalExpenses,
            openMaintenanceCount, totalTenants: tenants.length,
            totalHouses: houses.length, occupiedHouses: occupied, vacantHouses: houses.length - occupied,
            paymentConfigured: landlord.paymentConfigured, property: propertyInfo,
            landlordProfile: { name: landlord.name, propertyName: landlord.propertyName, propertyLocation: landlord.propertyLocation }
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

                const { totalCollected, percentage, amountDue, waived, creditApplied } = await computeCommissionForProperty(property._id, req.params.month);

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
            waived: !!waived,
            creditApplied: creditApplied || 0,
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
        const { totalCollected, percentage, amountDue, waived, creditApplied } = await computeCommissionForProperty(property._id, month);

        if (waived) {
            return res.status(400).json({ message: `Your referral reward covers commission for ${month} — nothing to pay 🎉`, waived: true });
        }
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
            creditApplied,
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

            // Consume whatever credit this payment was priced with. Atomic
            // guard so a balance already spent elsewhere (a rare concurrent
            // settlement) is never driven negative — if the guard fails we
            // just skip the decrement and log it; the payment itself must
            // still count as paid regardless.
            if (commissionPayment.creditApplied > 0) {
                const decremented = await Property.findOneAndUpdate(
                    { _id: commissionPayment.property._id, commissionCreditBalance: { $gte: commissionPayment.creditApplied } },
                    { $inc: { commissionCreditBalance: -commissionPayment.creditApplied } }
                );
                if (!decremented) {
                    console.warn(`Could not decrement commission credit for property ${commissionPayment.property._id} — balance may have changed concurrently`);
                }
            }

            await maybeAutoUnsuspendProperty(commissionPayment.property._id);

            // Safety net for the race where a refund lands between STK push
            // and confirmation — reconciles this month against fresh numbers.
            await reconcileCommissionOverpayment(commissionPayment.property._id, commissionPayment.month);

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

        if (req.user.role === 'landlord' || req.user.role === 'caretaker') {
            if (!req.query.propertyId) return res.status(400).json({ message: 'propertyId is required' });
            const landlordScope = await resolveLandlordScope(req);

            if (req.user.role === 'caretaker') {
                const caretaker = await User.findById(req.user.id).select('properties');
                const assigned  = (caretaker.properties || []).map(String).includes(String(req.query.propertyId));
                if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
            }

            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
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

app.post('/announcements', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        if (req.user.role === 'caretaker') {
            const caretakerCheck = await User.findById(req.user.id).select('caretakerPermissions');
            if (!caretakerCheck?.caretakerPermissions?.canPostAnnouncements) {
                return res.status(403).json({ message: 'You do not have permission to post announcements' });
            }
        }

        const landlordScope = await resolveLandlordScope(req);
        const propertyId = req.body.propertyId || null;
        const message    = sanitize(req.body.message || '', 1000);

        if (!propertyId) return res.status(400).json({ message: 'propertyId is required' });
        if (!message)    return res.status(400).json({ message: 'Message is required' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(propertyId));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        const property = await Property.findOne({ _id: propertyId, landlord: landlordScope });
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const a = await Announcement.create({ message, landlord: landlordScope, property: propertyId });
        res.json(a);
    } catch (err) {
        res.status(500).json({ message: 'Error creating announcement' });
    }
});

app.get('/announcements', authMiddleware, async (req, res) => {
    try {
        let query;

        if (req.user.role === 'landlord' || req.user.role === 'caretaker') {
            if (!req.query.propertyId) return res.status(400).json({ message: 'propertyId is required' });
            const landlordScope = await resolveLandlordScope(req);

            if (req.user.role === 'caretaker') {
                const caretaker = await User.findById(req.user.id).select('properties');
                const assigned  = (caretaker.properties || []).map(String).includes(String(req.query.propertyId));
                if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
            }

            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
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

        const tenant = await Tenant.findById(req.user.tenantId).select('property landlord status');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        if (tenant.status !== 'active') {
            return res.status(403).json({ message: 'Your tenancy has ended — messaging is closed.', code: 'TENANCY_ENDED' });
        }

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

app.post('/messages/reply', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        if (req.user.role === 'caretaker') {
            const caretakerCheck = await User.findById(req.user.id).select('caretakerPermissions');
            if (!caretakerCheck?.caretakerPermissions?.canMessageTenants) {
                return res.status(403).json({ message: 'You do not have permission to message tenants' });
            }
        }

        const landlordScope = await resolveLandlordScope(req);
        const tenantId = req.body.tenantId || '';
        const text     = sanitize(req.body.text || '', 2000);

        if (!tenantId || !text) {
            return res.status(400).json({ message: 'tenantId and text are required' });
        }

        const tenant = await Tenant.findOne({ _id: tenantId, landlord: landlordScope });
        if (!tenant) return res.status(403).json({ message: 'Forbidden' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(tenant.property));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

        // Always sent as 'landlord' — the tenant-facing chat UI only
        // distinguishes landlord vs tenant, not who on the landlord's
        // team actually typed the reply.
        const msg = await Message.create({
            landlord: landlordScope,
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
app.get('/messages/thread/:tenantId', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: landlordScope });
        if (!tenant) return res.status(403).json({ message: 'Forbidden' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(tenant.property));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

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
            const landlordScope = await resolveLandlordScope(req);
            const tenant = await Tenant.findOne({ _id: req.params.tenantId, landlord: landlordScope });
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

app.get('/messages/unread', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const matchQuery = {
            landlord: new mongoose.Types.ObjectId(landlordScope),
            sender:   'tenant',
            isRead:   false
        };

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            matchQuery.property = new mongoose.Types.ObjectId(req.query.propertyId);
        } else if (caretakerPropertyIds) {
            matchQuery.property = { $in: caretakerPropertyIds.map(id => new mongoose.Types.ObjectId(id)) };
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

// ── Stacklord: view/edit the referral-reward program ──
// NOTE: editing these settings only affects FUTURE qualification checks and
// FUTURE rewards. It never touches a User.referralQualifiedAt already set,
// or a ReferralReward already granted — those are immutable snapshots by
// design (see checkReferralQualification / ReferralReward.js).
app.get('/stacklord/referral-settings', stacklordAuth, async (req, res) => {
    try {
        const settings = await getPlatformSettings();
        res.json({
            referralRequiredCount:       settings.referralRequiredCount || 5,
            referralRewardDurationMonths: settings.referralRewardDurationMonths || 1,
            referralQualificationRules:  settings.referralQualificationRules || {
                newLandlord: true, propertySetupCompleted: true, firstPaymentProcessed: true
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/stacklord/referral-settings', stacklordAuth, async (req, res) => {
    try {
        const requiredCount = Number(req.body.referralRequiredCount);
        if (!Number.isInteger(requiredCount) || requiredCount < 1) {
            return res.status(400).json({ message: 'referralRequiredCount must be a whole number of at least 1' });
        }

        const rules = req.body.referralQualificationRules || {};
        const normalizedRules = {
            newLandlord:            true, // registration source is always required — not a real toggle
            propertySetupCompleted: !!rules.propertySetupCompleted,
            firstPaymentProcessed:  !!rules.firstPaymentProcessed
        };

        let settings = await PlatformSettings.findOne();
        if (!settings) settings = new PlatformSettings({ commissionPercentage: 0 });

        settings.referralRequiredCount        = requiredCount;
        settings.referralRewardDurationMonths = 1; // only one reward duration is supported today — kept explicit for when that changes
        settings.referralQualificationRules   = normalizedRules;
        await settings.save();

        res.json({ message: 'Referral settings saved ✅', settings });
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

        const { totalCollected, percentage, amountDue, creditApplied } = await computeCommissionForProperty(propertyId, month);
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
                creditApplied,
                status:    'paid',
                mpesaCode: 'MANUAL',
                paidAt:    new Date(),
                note
            },
            { upsert: true, returnDocument: 'after' }
        );

        if (creditApplied > 0) {
            const decremented = await Property.findOneAndUpdate(
                { _id: propertyId, commissionCreditBalance: { $gte: creditApplied } },
                { $inc: { commissionCreditBalance: -creditApplied } }
            );
            if (!decremented) {
                console.warn(`Could not decrement commission credit for property ${propertyId} — balance may have changed concurrently`);
            }
        }

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
                    from:    'Affordable Rentals <support@affordablerentals.site>',
                    to:      landlord.email,
                    subject: `New Inquiry — ${property.name}`,
                    html: `
                    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                      <div style="background:linear-gradient(135deg,#1d4ed8,#0ea5e9);padding:28px 32px;text-align:center">
                        <div style="font-size:36px;margin-bottom:8px">${emailIcon('mail', 36, 'white')}</div>
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
                          <a href="tel:${phone}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600">${emailIcon('phone', 14, 'white')} Call Now</a>
                          <a href="https://wa.me/${phone.replace(/[^0-9]/g,'').replace(/^0/,'254')}?text=${encodeURIComponent(`Hi ${name}, I'm ${landlord.name} from ${property.name}. Thanks for your inquiry!`)}" style="display:inline-block;background:#25d366;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600">${emailIcon('messages', 14, 'white')} WhatsApp</a>
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

app.get('/inquiries', authMiddleware, landlordOrCaretaker, checkAccountStatus, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query  = { landlord: landlordScope };
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(50, parseInt(req.query.limit) || 20);
        const skip   = (page - 1) * limit;

        let caretakerPropertyIds = null;
        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            caretakerPropertyIds = (caretaker.properties || []).map(String);
        }

        if (req.query.propertyId) {
            if (caretakerPropertyIds && !caretakerPropertyIds.includes(String(req.query.propertyId))) {
                return res.status(403).json({ message: 'You are not assigned to this property' });
            }
            const property = await Property.findOne({ _id: req.query.propertyId, landlord: landlordScope });
            if (!property) return res.status(404).json({ message: 'Property not found' });
            query.property = req.query.propertyId;
        } else if (caretakerPropertyIds) {
            query.property = { $in: caretakerPropertyIds };
        }

        // Base scope (before status filter) reused for the unread count below,
        // so a caretaker's badge only ever counts inquiries on their own properties.
        const unreadQuery = { ...query, status: 'new' };

        if (req.query.status) {
            query.status = req.query.status;
        }

        const [inquiries, total, unreadCount] = await Promise.all([
            Inquiry.find(query)
                .populate('property', 'name location')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Inquiry.countDocuments(query),
            Inquiry.countDocuments(unreadQuery)
        ]);

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

app.get('/inquiries/unread-count', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const landlordScope = await resolveLandlordScope(req);
        const query = { landlord: landlordScope, status: 'new' };

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            query.property = { $in: (caretaker.properties || []).map(String) };
        }

        const count = await Inquiry.countDocuments(query);
        res.json({ count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────
//  PUT /inquiries/:id/status
//  Update inquiry status: new → read → contacted → archived
// ─────────────────────────────────────────────────────────

app.put('/inquiries/:id/status', authMiddleware, landlordOrCaretaker, async (req, res) => {
    try {
        const { status, notes } = req.body;
        const allowed = ['new', 'read', 'contacted', 'archived'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ message: `Status must be one of: ${allowed.join(', ')}` });
        }

        const landlordScope = await resolveLandlordScope(req);
        const inquiry = await Inquiry.findOne({ _id: req.params.id, landlord: landlordScope });
        if (!inquiry) return res.status(404).json({ message: 'Inquiry not found' });

        if (req.user.role === 'caretaker') {
            const caretaker = await User.findById(req.user.id).select('properties');
            const assigned  = (caretaker.properties || []).map(String).includes(String(inquiry.property));
            if (!assigned) return res.status(403).json({ message: 'You are not assigned to this property' });
        }

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
    const today = new Date();
    const currentDay = today.getDate();
    const calendarMonth = today.toLocaleString('default', { month: 'long', year: 'numeric' });
    const todayKey = today.toISOString().slice(0, 10);

    console.log(`🕘 Running rent check...`);

    try {
        const activeLandlords = await User.find({ role: 'landlord', accountStatus: 'active' }).select('_id');
        const landlordIds = activeLandlords.map(l => l._id);
        const tenants = await Tenant.find({ landlord: { $in: landlordIds }, status: 'active' }).populate('house');

        await settleGapHolds();
        const holdMap = await getActiveHoldMap(tenants.map(t => t._id));

        for (const tenant of tenants) {
            if (!tenant.house) continue;

            const isSemester = (tenant.house.billingCycle || 'monthly') === 'semester';
            let periodLabel, cycleDueDay = null;

            if (isSemester) {
                const property = await Property.findById(tenant.property).select('semesterRule');
                const rule = normalizeSemesterRule(property?.semesterRule || {});
                if (!rule.enabled) continue;

                // The semester the tenant is under — never a semester that has not started yet.
                const ctx = await getSemesterContext(rule, tenant, today);
                if (!ctx.started) continue;
                const window = ctx.window;
                periodLabel = formatSemesterPeriodLabel(window);
                const dueDateActual = computeSemesterDueDate(window);
                if (holdExcludesWindow(holdMap.get(String(tenant._id)), window)) continue;
                if (today < dueDateActual) continue;
            } else {
                // A monthly tenant who is away on holiday is not chased for rent.
                if ((holdMap.get(String(tenant._id)) || []).some(h => h.status === 'active')) continue;
                const cyc = computeMonthlyCycle(tenant, today);
                if (cyc.mode === 'legacy') {
                    // Legacy tenant: calendar month, reminders from the due day onward (unchanged).
                    periodLabel = calendarMonth;
                    if (currentDay < (Number(tenant.dueDate) || 5)) continue;
                } else {
                    // Anniversary tenant: rent falls due at the END of a cycle, so only the cycle that has
                    // just ended can be overdue. Nothing is overdue during a tenant's first cycle.
                    if (!cyc.prevKey) continue;
                    periodLabel = cyc.prevKey;
                    cycleDueDay = cyc.start.getDate();   // the previous cycle ended the day this one began
                }
            }

            const rent = await getEffectiveRentForTenant(tenant, periodLabel);

            const totalPaidAgg = await Payment.aggregate([
                { $match: { tenant: tenant._id, $or: [{ month: periodLabel }, { periodLabel }], category: 'rent', status: { $in: ['paid', 'partial'] } } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]);
            const totalPaid = totalPaidAgg[0]?.total || 0;
            const balance = Math.max(0, rent - totalPaid);
            if (balance === 0) continue;

            const reminderKey = `${tenant._id}:${periodLabel}:${todayKey}`;
            if (reminderLog.has(reminderKey)) continue;

            console.log(`⚠️  ${tenant.name} — balance Ksh ${balance} for ${periodLabel} — sending reminder`);

            const emailCtx = await getEmailPeriodContext(tenant, periodLabel);

            sendRentReminder({
                name: tenant.name, email: tenant.email, house: tenant.house.name,
                rent, month: periodLabel, dueDate: isSemester ? undefined : (cycleDueDay || tenant.dueDate), arrears: balance,
                cycle:           emailCtx.cycle,
                periodRange:     emailCtx.periodRange,
                dueDateText:     emailCtx.dueDateText,
                extensionCharge: emailCtx.extensionCharge
            }).catch(err => console.error(`Reminder email failed for ${tenant.name}:`, err.message));

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

// Between semesters: close the holds that have reached their end date, and apply each property's
// gap policy ('auto' = default holding fee, 'none' = no fee) for tenants who are in a gap right now.
async function runGapMaintenance() {
    try {
        await settleGapHolds();
        const properties = await Property.find({
            'semesterRule.enabled': true, 'semesterRule.gapPolicy': { $in: ['auto', 'none'] }
        }).select('name landlord semesterRule');
        const now = new Date();
        for (const property of properties) {
            const rule    = normalizeSemesterRule(property.semesterRule || {});
            const tenants = await Tenant.find({ property: property._id, status: 'active', house: { $ne: null } }).populate('house', 'name billingCycle');
            for (const t of tenants) {
                if (!t.house || (t.house.billingCycle || 'monthly') !== 'semester') continue;
                const ctx = await getSemesterContext(rule, t, now);
                if (ctx.mode !== 'between') continue;
                const holds = await HolidayHold.find({ tenant: t._id, status: { $in: ['active', 'returned'] } }).select('status startDate kind').lean();
                await applyGapPolicyIfNeeded({ tenant: t, property, rule, ctx, holds });
            }
        }
    } catch (err) {
        console.error('runGapMaintenance error:', err.message);
    }
}
cron.schedule('10 0 * * *', () => { runGapMaintenance(); });


// ═══════════════════════════════════════
// BUILDINGS & HOUSE APPLICATIONS
// ═══════════════════════════════════════
const { resolvePlacement } = createBuildingHelpers({ mongoose, HouseGroup });

const { notifyApplicationReceived, notifyApplicationDecision } =
    createApplicationNotifiers({ Tenant, House, HouseGroup, Property, User });

const { assignTenantToHouse, settleApplicationsAfterAssignment } = createAssigner({
    Tenant, House, Property, User, TenantMembership, HouseApplication,
    resolveLandlordScope, getActorName, logActivity,
    tenantHasValidDeposit, getRequiredDepositAmount,
    notifyApplicationDecision
});

const { transferTenantToHouse } = createTransferService({
    Tenant, House, Billing, TenantMembership, HolidayHold, Property, User,
    resolveLandlordScope, getActorName, logActivity, computeMonthlyCycle
});

const _buildingRouteDeps = {
    mongoose, House, HouseGroup, Property, Tenant, User, HouseApplication,
    authMiddleware, landlordOnly, landlordOrCaretaker, checkAccountStatus, checkPropertySuspension,
    resolveLandlordScope, sanitize, logActivity, getActorName,
    tenantHasValidDeposit, getRequiredDepositAmount, normalizeSemesterRule,
    assignTenantToHouse, settleApplicationsAfterAssignment,
    notifyApplicationReceived, notifyApplicationDecision
};
registerBuildingRoutes(app, _buildingRouteDeps);
registerApplicationRoutes(app, _buildingRouteDeps);


// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT} 🚀`);
});