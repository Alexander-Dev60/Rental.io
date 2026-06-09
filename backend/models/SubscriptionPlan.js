// models/SubscriptionPlan.js
const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema({

    name: {
        type:     String,
        required: true,
        trim:     true
    },

    price: {
        type:     Number,
        required: true,
        min:      [0, 'Price must be greater than or equal to 0']
    },

    durationDays: {
        type:     Number,
        required: true,
        default:  30,
        min:      [1, 'Duration must be at least 1 day']
    },

    description: {
        type:    String,
        default: ''
    },

    features: {
        type:    [String],
        default: []
    },

    // ── Limits ──
    // -1 = unlimited
    maxProperties: {
        type:    Number,
        default: 1   // Starter: 1 property
    },

    maxTenantsPerProperty: {
        type:    Number,
        default: 20  // Starter: 20 tenants per property
    },

    isActive: {
        type:    Boolean,
        default: true
    },

    sortOrder: {
        type:    Number,
        default: 0
    },

    createdBy: {
        type:    String,
        default: 'stacklord'
    }

}, { timestamps: true });

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);