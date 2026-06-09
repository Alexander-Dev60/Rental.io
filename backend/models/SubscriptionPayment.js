const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════
//  models/SubscriptionPayment.js
// ═══════════════════════════════════════════════════════
const subscriptionPaymentSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    plan: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'SubscriptionPlan',
        required: true
    },

    amount: {
        type:     Number,
        required: true
    },

    durationDays: {
        type:     Number,
        required: true
    },

    expiresAt: {
        type:    Date,
        default: null
    },

    status: {
        type:    String,
        enum:    ['pending', 'paid', 'failed'],
        default: 'pending'
    },

    mpesaCode:         { type: String, default: null },
    checkoutRequestId: { type: String, default: null },
    merchantRequestId: { type: String, default: null },

    phone: {
        type:    String,
        default: null
    },

    paidAt: {
        type:    Date,
        default: null
    },

    manuallyExtended: {
        type:    Boolean,
        default: false
    },

    manualNote: {
        type:    String,
        default: null
    }

}, { timestamps: true });

subscriptionPaymentSchema.index({ landlord: 1, status: 1 });
subscriptionPaymentSchema.index({ checkoutRequestId: 1 });

module.exports = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);
