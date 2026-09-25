// models/ReferralReward.js
//
// One document per landlord, EVER. That's the whole enforcement mechanism
// for "refer 5, get 1 free month — even if you refer 20, you only ever get
// one": the unique index on `landlord` below means a second attempt to
// create a reward for the same landlord throws a duplicate-key error
// (E11000) instead of succeeding. See maybeGrantReferralReward() in app.js,
// which relies on catching that error rather than trusting an in-memory
// "does one already exist" check (which would race under concurrent
// qualification events).
//
// Status ('scheduled' / 'active' / 'consumed') is intentionally NOT stored
// here — it's derived from periodStart/periodEnd vs. the current time (see
// getReferralRewardStatus() in app.js). Storing and flipping a status field
// would need a cron job to keep it in sync and could drift; deriving it is
// always correct and needs no background job.
//
// qualifyingReferrals is a snapshot of exactly which referred landlords
// triggered the reward, taken at grant time. It never changes afterward —
// even if one of those referrals later churns, gets suspended, or is
// deleted, the reward they already earned stands. Also useful for support
// ("why did I get this reward") and for admin auditing.

const mongoose = require('mongoose');

const referralRewardSchema = new mongoose.Schema({

    // The landlord who earned the reward (the REFERRER, not the referred).
    // Unique — see header note above. This is what makes the reward
    // lifetime-capped at exactly one, regardless of how many qualified
    // referrals follow. (Enforced here via `unique: true` on the field
    // itself — NOT also via a separate schema.index() call below, which
    // would just declare the same index twice and trigger a Mongoose
    // duplicate-index warning at startup.)
    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true,
        unique:   true
    },

    // Snapshot of the specific referred-landlord User _ids credited for this
    // reward (the earliest N to reach referralQualifiedAt, where N is
    // requiredCountAtGrant below).
    qualifyingReferrals: [{
        type: mongoose.Schema.Types.ObjectId,
        ref:  'User'
    }],

    // Snapshot of PlatformSettings.referralRequiredCount at the moment this
    // reward was granted — so a later admin change to the threshold never
    // rewrites the meaning of an already-earned reward.
    requiredCountAtGrant: {
        type:     Number,
        required: true
    },

    // Which rent-commission month this reward waives, in the SAME string
    // format Payment.month / CommissionPayment.month use (e.g. "October 2026").
    // computeCommissionForProperty() matches on this string directly.
    month: {
        type:     String,
        required: true
    },

    // Calendar bounds of `month`, precomputed at grant time so nothing else
    // needs to re-derive them from the month string.
    periodStart: {
        type:     Date,
        required: true
    },

    periodEnd: {
        type:     Date,
        required: true
    },

    earnedAt: {
        type:    Date,
        default: Date.now
    }

}, { timestamps: true });

module.exports = mongoose.model('ReferralReward', referralRewardSchema);