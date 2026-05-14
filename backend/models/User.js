const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({

    // ── Core ──
    name: {
        type:     String,
        required: true,
        trim:     true
    },

    email: {
        type:      String,
        required:  true,
        unique:    true,
        lowercase: true,
        trim:      true
    },

    password: {
        type:     String,
        required: true
    },

    role: {
        type:    String,
        enum:    ['admin', 'tenant'],
        default: 'tenant'
    },

    // ── Tenant link (null for admin) ──
    tenantId: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'Tenant',
        default: null
    },

    // ══════════════════════════════════════════
    // SUBSCRIPTION FIELDS — admin (landlord) only
    // These are ignored for tenant accounts
    // ══════════════════════════════════════════

    subscriptionStatus: {
        type:    String,
        enum:    ['trial', 'active', 'grace', 'expired', 'suspended'],
        default: 'trial'
    },

    subscriptionPlan: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'SubscriptionPlan',
        default: null
    },

    // When current subscription period ends
    subscriptionExpiry: {
        type:    Date,
        default: null   // set on first payment or trial start
    },

    // Trial end date — set when admin account is created
    trialEndsAt: {
        type:    Date,
        default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) // 14 days
    },

    // Grace period — 7 days after expiry before full lockout
    gracePeriodUntil: {
        type:    Date,
        default: null
    },

    // Last successful subscription payment date
    lastSubscriptionPayment: {
        type:    Date,
        default: null
    },

    // Admin's phone number used for subscription STK Push
    landlordPhone: {
        type:    String,
        default: null,
        trim:    true
    },

    // Admin's own Paybill for tenant rent collection
    paybillNumber: {
        type:    String,
        default: null,
        trim:    true
    },

    paybillPasskey: {
        type:    String,
        default: null
    },

    mpesaConsumerKey: {
        type:    String,
        default: null
    },

    mpesaConsumerSecret: {
        type:    String,
        default: null
    },

    // ── Suspension ──
    suspendedReason: {
        type:    String,
        default: null
    },

    suspendedAt: {
        type:    Date,
        default: null
    },

    suspendedBy: {
        type:    String,  // 'stacklord' always
        default: null
    }

}, { timestamps: true });

// ── Virtual: is subscription currently active ──
userSchema.virtual('isSubscriptionActive').get(function () {
    if (this.role !== 'admin') return true; // tenants always pass

    const now = new Date();

    switch (this.subscriptionStatus) {
        case 'trial':
            return this.trialEndsAt && now < this.trialEndsAt;
        case 'active':
            return this.subscriptionExpiry && now < this.subscriptionExpiry;
        case 'grace':
            return this.gracePeriodUntil && now < this.gracePeriodUntil;
        case 'expired':
        case 'suspended':
            return false;
        default:
            return false;
    }
});

// ── Virtual: days remaining ──
userSchema.virtual('daysRemaining').get(function () {
    const now = new Date();
    let expiry = null;

    if (this.subscriptionStatus === 'trial')  expiry = this.trialEndsAt;
    if (this.subscriptionStatus === 'active') expiry = this.subscriptionExpiry;
    if (this.subscriptionStatus === 'grace')  expiry = this.gracePeriodUntil;

    if (!expiry) return 0;
    return Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));
});

userSchema.set('toJSON',   { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);