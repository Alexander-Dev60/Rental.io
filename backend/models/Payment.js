const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({

    tenant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tenant',
        required: true
    },

    house: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'House',
        required: true
    },

    // Amount paid in THIS transaction (one payment record per transaction)
    amount: {
        type: Number,
        required: true,
        min: [1, 'Payment amount must be greater than 0']
    },

    month: {
        type: String,
        required: true  // e.g. "April 2026"
    },

    // The monthly rent at the time of payment (snapshot in case rent changes)
    rentAmount: {
        type: Number,
        required: true
    },

    // Running total paid for this month AFTER this transaction
    totalPaid: {
        type: Number,
        required: true
    },

    // Remaining balance AFTER this transaction (can be 0 or positive, never negative)
    balance: {
        type: Number,
        required: true
    },

    // UNPAID = nothing paid, PARTIAL = some paid, PAID = fully paid
    status: {
        type: String,
        enum: ['unpaid', 'partial', 'paid', 'pending', 'failed'],
        default: 'paid'
    },

    // Payment method
    method: {
        type: String,
        enum: ['mpesa', 'cash', 'bank', 'other'],
        default: 'cash'
    },

    // M-Pesa specific fields
    mpesaCode:         { type: String, default: null },
    checkoutRequestId: { type: String, default: null },
    merchantRequestId: { type: String, default: null },

    datePaid: {
        type: Date,
        default: Date.now
    },

    // Optional note from admin
    note: {
        type: String,
        default: ''
    }

}, { timestamps: true });

// ── Index for fast monthly lookups ──
paymentSchema.index({ tenant: 1, month: 1 });
paymentSchema.index({ checkoutRequestId: 1 });

module.exports = mongoose.model('Payment', paymentSchema);