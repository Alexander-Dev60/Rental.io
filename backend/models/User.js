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
        enum:    ['landlord', 'tenant', 'caretaker'],
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

    // ── Caretaker-only fields ──
    // `landlordId` above (already used for tenants) doubles as "which
    // landlord this caretaker works for". `properties` scopes exactly
    // which properties they can see/act on — a caretaker may only be
    // assigned a subset of a landlord's full portfolio.
    properties: [{
        type: mongoose.Schema.Types.ObjectId,
        ref:  'Property',
        default: []
    }],

        caretakerPermissions: {
        canRecordPayments:    { type: Boolean, default: true },
        canManageMaintenance: { type: Boolean, default: true },
        canMessageTenants:    { type: Boolean, default: true },
        canPostAnnouncements: { type: Boolean, default: false },
        canManageTenants:     { type: Boolean, default: false }
    },
    
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

// ── Compound index for caretaker lookups — every caretaker-scoped query
// filters by landlordId + role: 'caretaker' together (e.g. GET
// /landlord/caretakers, checkCaretakerPropertyAccess). A compound index
// here is more efficient than relying on the two separate single-field
// indexes above, since Mongo can satisfy the whole filter from one index
// scan instead of intersecting two. ──
userSchema.index({ landlordId: 1, role: 1 });
userSchema.set('toJSON',   { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);