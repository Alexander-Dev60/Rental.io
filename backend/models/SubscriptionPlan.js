const mongoose = require('mongoose');

// ══════════════════════════════════════════════════════
//  SubscriptionPlan.js
//  Plans are created and managed by Stacklord only.
//  Landlords choose from active plans when subscribing.
// ══════════════════════════════════════════════════════

const subscriptionPlanSchema = new mongoose.Schema({

    // Plan display name e.g. "Basic", "Pro", "Starter"
    name: {
        type:     String,
        required: true,
        trim:     true
    },

    // Price in Ksh
    price: {
        type:     Number,
        required: true,
        min:      [1, 'Price must be greater than 0']
    },

    // How many days this plan covers
    durationDays: {
        type:     Number,
        required: true,
        default:  30,
        min:      [1, 'Duration must be at least 1 day']
    },

    // What's included — shown to landlord on renewal page
    description: {
        type:    String,
        default: ''
    },

    // Features list — array of strings
    features: {
        type:    [String],
        default: []
    },

    // Stacklord can deactivate a plan without deleting it
    isActive: {
        type:    Boolean,
        default: true
    },

    // Sort order on the renewal page (lower = first)
    sortOrder: {
        type:    Number,
        default: 0
    },

    // Who created this plan (always 'stacklord')
    createdBy: {
        type:    String,
        default: 'stacklord'
    }

}, { timestamps: true });

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);