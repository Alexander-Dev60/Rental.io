// ═══════════════════════════════════════════════════════
//  models/User.js — SaaS Multi-tenant version
//  role: 'landlord' | 'tenant'
//
//  FIX (commission model migration): removed the entire paid-plan
//  subscription lifecycle (subscriptionStatus enum, subscriptionPlan,
//  subscriptionExpiry, trialEndsAt, gracePeriodUntil,
//  lastSubscriptionPayment) — the platform is free forever now, funded
//  by a per-property commission on collected rent instead of a paid
//  plan. `accountStatus` replaces `subscriptionStatus` and only ever
//  means "can this landlord use the platform" (active/suspended) —
//  it's a moderation switch, not a billing one.
//
//  Added `lastSeenCommissionUpdatedAt` so the dashboard can detect
//  "the stacklord changed the commission rate since I last looked"
//  and show a one-time notice.
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

    // ── FIX: replaces subscriptionStatus. Free platform now — this is
    // purely a moderation switch (stacklord suspend/unsuspend), not a
    // billing state. No trial/active/grace/expired lifecycle anymore. ──
    accountStatus: {
        type:    String,
        enum:    ['active', 'suspended'],
        default: 'active'
    },

    // ── FIX: commission-rate-change notice tracking. Compared against
    // PlatformSettings.updatedAt on dashboard load — if this is older
    // (or null), the landlord hasn't seen the current rate yet and the
    // dashboard shows a one-time banner. Updated via
    // PUT /landlord/commission-notice/ack. ──
    lastSeenCommissionUpdatedAt: {
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

userSchema.set('toJSON',   { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);