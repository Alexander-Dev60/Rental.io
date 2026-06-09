// ═══════════════════════════════════════════════════════
//  models/Payment.js — SaaS Multi-tenant version
//  Added: landlord ref for data isolation
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════
//  models/Payment.js
// ═══════════════════════════════════════════════════════
const paymentSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // ── Which property this payment belongs to ──
    property: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Property',
        required: true
    },

    tenant: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Tenant',
        required: true
    },

    house: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'House',
        required: true
    },

    amount: {
        type:     Number,
        required: true,
        min:      [1, 'Payment amount must be greater than 0']
    },

    month: {
        type:     String,
        required: true
    },

    rentAmount: {
        type:     Number,
        required: true
    },

    totalPaid: {
        type:     Number,
        required: true
    },

    balance: {
        type:     Number,
        required: true
    },

    status: {
        type:    String,
        enum:    ['unpaid', 'partial', 'paid', 'pending', 'failed'],
        default: 'paid'
    },

    method: {
        type:    String,
        enum:    ['mpesa', 'cash', 'bank', 'other'],
        default: 'cash'
    },

    mpesaCode:         { type: String, default: null },
    checkoutRequestId: { type: String, default: null },
    merchantRequestId: { type: String, default: null },

    datePaid: {
        type:    Date,
        default: Date.now
    },

    note: {
        type:    String,
        default: ''
    }

}, { timestamps: true });

paymentSchema.index({ property: 1, tenant: 1, month: 1 });
paymentSchema.index({ property: 1, month: 1 });
paymentSchema.index({ landlord: 1, property: 1 });
paymentSchema.index({ checkoutRequestId: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
