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

// AFTER:
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
    suspendedBy:     { type: String, default: null },

    // ── Referral program (landlords only) ──
    // Set once, at registration, from the ?ref= param on the signup link —
    // never updated afterward. Points at the referring landlord's own User
    // _id. Null for the vast majority of accounts (organic signups, tenants,
    // caretakers), so this is deliberately left out of the compound/query
    // indexes below — GET /landlord/referrals filters by this field but at
    // low-to-moderate volume a collection scan is fine, and adding an index
    // for a field this sparse isn't worth the write-overhead yet.
    referredBy: {
        type:    mongoose.Schema.Types.ObjectId,
        ref:     'User',
        default: null
    },

    // ── Public referral code — what actually appears in a shareable link ──
    // Deliberately NOT the same thing as this landlord's own _id: an
    // ObjectId embeds a timestamp and has low real-world entropy, so handing
    // it out in a link that gets forwarded around WhatsApp is a guessable,
    // permanent, unrotatable handle straight into the database. This field
    // is a separate, opaque, revocable value that only ever maps back to the
    // landlord server-side (see getOrCreateReferralCode() in app.js) —
    // sparse so non-landlord roles with no code don't collide on null.
    //
    // NOTE: deliberately NO `default: null` here. A sparse index only skips
    // documents where the field is truly absent — a document with the field
    // explicitly set to null is still indexed, so a default of null would
    // mean the second user ever saved (tenant, caretaker, anyone) throws a
    // duplicate-key error on a field they never touched. Leaving the field
    // genuinely unset until getOrCreateReferralCode() assigns one is what
    // makes `sparse` actually work as intended.
    referralCode: {
        type:   String,
        unique: true,
        sparse: true
    },

    // ── Referral qualification (referred landlords only) ──
    // Set EXACTLY ONCE, the first time this landlord satisfies whatever
    // qualification rules are enabled in PlatformSettings.referralQualificationRules
    // (see checkReferralQualification() in app.js). Never re-evaluated or
    // cleared afterward — if the stacklord tightens the rules later, landlords
    // who already qualified under the old rules stay qualified. This is the
    // field maybeGrantReferralReward() counts against referralRequiredCount.
    referralQualifiedAt: {
        type:    Date,
        default: null
    }

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