// models/PlatformSettings.js
//
// Singleton document — there is only ever one PlatformSettings row.
// Holds the commission percentage the stacklord charges landlords on
// their monthly rent collections, plus enough metadata to detect
// "this changed since the landlord last saw it" for the dashboard notice.
//
// Fetch pattern everywhere in the app:
//   let settings = await PlatformSettings.findOne();
//   if (!settings) settings = await PlatformSettings.create({ commissionPercentage: 0 });
//
// Never create a second document — there is intentionally no unique
// business key here because the whole point is "the one row."

const mongoose = require('mongoose');

const platformSettingsSchema = new mongoose.Schema({

    // Percentage (0–100) of collected rent owed to the platform.
    // e.g. 5 means 5% of a property's monthly collected rent.
    commissionPercentage: {
        type:     Number,
        required: true,
        default:  0,
        min:      0,
        max:      100
    },

    // ═══════════════════════════════════════════════════════════════════════
// models/PlatformSettings.js — NOT included in your upload, so I couldn't
// edit it directly. Add the fields below into the existing schema
// definition (alongside commissionPercentage, platformMaintenanceMode,
// etc.) — everything else in that file stays exactly as it is.
// ═══════════════════════════════════════════════════════════════════════

// Inside your existing `new mongoose.Schema({ ... })` block, add:

    referralRequiredCount: {
        type:    Number,
        default: 5
    },

    // Only 1 is supported by the current app.js logic (see
    // /stacklord/referral-settings PUT handler) — kept as its own field so
    // multi-month rewards can be added later without a schema migration.
    referralRewardDurationMonths: {
        type:    Number,
        default: 1
    },

    referralQualificationRules: {
        newLandlord:            { type: Boolean, default: true },
        propertySetupCompleted: { type: Boolean, default: true },
        firstPaymentProcessed:  { type: Boolean, default: true }
    },

// ═══════════════════════════════════════════════════════════════════════
// That's it — no other changes needed. getPlatformSettings() in app.js
// already falls back to sensible defaults (5 / 1 / all-rules-on) via `||`
// if these fields are momentarily absent on an old document, so this is
// safe to deploy without a manual data migration; existing PlatformSettings
// documents will just pick up the schema defaults the next time they're
// loaded and re-saved.
// ═══════════════════════════════════════════════════════════════════════

    platformMaintenanceMode:    { type: Boolean, default: false },
    platformMaintenanceMessage: { type: String,  default: '' },
    autoApproveListings:        { type: Boolean, default: false },

    // Who last changed it and when — 'when' is what dashboards compare
    // against a landlord's `lastSeenCommissionUpdatedAt` to decide
    // whether to show the "rate changed" notice.
    updatedAt: {
        type:    Date,
        default: Date.now
    },

    updatedBy: {
        type:    String,
        default: 'stacklord'
    }

}, { timestamps: true });

module.exports = mongoose.model('PlatformSettings', platformSettingsSchema);