// ═══════════════════════════════════════════════════════
//  models/User.js — SaaS Multi-tenant version
//  role: 'landlord' | 'tenant'
//  (renamed from 'admin' → 'landlord')
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({

    name: {
        type:     String,
        required: true,
        trim:     true
    },

    email: {
        type:      String,
        required:  true,
        unique:    true,   // single-field unique — OK to keep here only
        lowercase: true,
        trim:      true
    },

    password: {
        type:     String,
        required: true
    },

    role: {
        type:    String,
        enum:    ['landlord', 'tenant'],
        default: 'tenant'
    },

    tenantId: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'Tenant',
        default: null
    },

    landlordId: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'User',
        default: null
    },

    propertyName: {
        type:    String,
        trim:    true,
        default: null
    },

    propertyLocation: {
        type:    String,
        trim:    true,
        default: null
    },

    phone: {
        type:    String,
        trim:    true,
        default: null
    },

    // No unique/sparse here — handled exclusively by schema.index() below
    subdomain: {
        type:      String,
        trim:      true,
        lowercase: true,
        //default:   null
    },

    onboardingComplete: {
        type:    Boolean,
        default: false
    },

    paymentConfigured: {
        type:    Boolean,
        default: false
    },

    paybillNumber: {
        type:    String,
        default: null,
        trim:    true
    },

    mpesaConsumerKey: {
        type:    String,
        default: null
    },

    mpesaConsumerSecret: {
        type:    String,
        default: null
    },

    mpesaPasskey: {
        type:    String,
        default: null
    },

    mustChangePassword: {
        type:    Boolean,
        default: false
    },

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

    subscriptionExpiry: {
        type:    Date,
        default: null
    },

    trialEndsAt: {
        type:    Date,
        default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    },

    gracePeriodUntil: {
        type:    Date,
        default: null
    },

    lastSubscriptionPayment: {
        type:    Date,
        default: null
    },

    landlordPhone: {
        type:    String,
        default: null,
        trim:    true
    },

    // ── Terms of Service / Privacy Policy acceptance (landlords only) ──
    // Recorded at registration so there's a durable, queryable record of
    // *when* and *which version* of the terms a landlord agreed to — the
    // frontend checkbox alone proves nothing once the request leaves the browser.
    termsAcceptedAt: {
        type:    Date,
        default: null
    },

    termsVersion: {
        type:    String,
        default: null
    },

    suspendedReason: { type: String, default: null },
    suspendedAt:     { type: Date,   default: null },
    suspendedBy:     { type: String, default: null }

}, { timestamps: true });

// ── Indexes (single source of truth — nothing duplicated on fields above) ──
userSchema.index({ landlordId: 1 });
userSchema.index({ role: 1 });
userSchema.index({ subdomain: 1 }, { unique: true, sparse: true }); // sparse → nulls don't collide

// ── Virtual: subscription days remaining ──
userSchema.virtual('daysRemaining').get(function () {
    const now = new Date();
    let expiry = null;
    if (this.subscriptionStatus === 'trial')  expiry = this.trialEndsAt;
    if (this.subscriptionStatus === 'active') expiry = this.subscriptionExpiry;
    if (this.subscriptionStatus === 'grace')  expiry = this.gracePeriodUntil;
    if (!expiry) return 0;
    return Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));
});

// ── Virtual: is subscription active ──
userSchema.virtual('isSubscriptionActive').get(function () {
    if (this.role !== 'landlord') return true;
    const now = new Date();
    switch (this.subscriptionStatus) {
        case 'trial':  return this.trialEndsAt && now < this.trialEndsAt;
        case 'active': return this.subscriptionExpiry && now < this.subscriptionExpiry;
        case 'grace':  return this.gracePeriodUntil && now < this.gracePeriodUntil;
        default:       return false;
    }
});

userSchema.set('toJSON',   { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);