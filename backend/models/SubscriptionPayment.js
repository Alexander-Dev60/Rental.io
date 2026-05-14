const mongoose = require('mongoose');

// ══════════════════════════════════════════════════════
//  SubscriptionPayment.js
//  Records every subscription payment attempt.
//  Completely separate from rent Payment.js.
// ══════════════════════════════════════════════════════

const subscriptionPaymentSchema = new mongoose.Schema({

    // The landlord (admin User) who made this payment
    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // Which plan they paid for
    plan: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'SubscriptionPlan',
        required: true
    },

    // Amount paid in Ksh
    amount: {
        type:     Number,
        required: true
    },

    // How many days this payment covers (snapshot from plan)
    durationDays: {
        type:     Number,
        required: true
    },

    // New expiry date after this payment is applied
    expiresAt: {
        type:    Date,
        default: null
    },

    // Payment status
    status: {
        type:    String,
        enum:    ['pending', 'paid', 'failed'],
        default: 'pending'
    },

    // M-Pesa details
    mpesaCode: {
        type:    String,
        default: null
    },

    checkoutRequestId: {
        type:    String,
        default: null
    },

    merchantRequestId: {
        type:    String,
        default: null
    },

    // Phone used for STK Push
    phone: {
        type:    String,
        default: null
    },

    // When payment was confirmed
    paidAt: {
        type:    Date,
        default: null
    },

    // If manually extended by Stacklord
    manuallyExtended: {
        type:    Boolean,
        default: false
    },

    manualNote: {
        type:    String,
        default: null
    }

}, { timestamps: true });

// Index for fast lookups
subscriptionPaymentSchema.index({ landlord: 1, status: 1 });
subscriptionPaymentSchema.index({ checkoutRequestId: 1 });

module.exports = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);