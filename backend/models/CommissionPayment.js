// models/CommissionPayment.js
//
// Replaces SubscriptionPayment. One document per (property, month) commission
// cycle. `totalCollected` and `amountDue` are snapshotted at the moment the
// landlord initiates payment — NOT recalculated later — so a mid-month rate
// change or a late-recorded cash payment doesn't silently alter a pending
// STK push's amount after the fact. The commission summary endpoint always
// computes fresh from Payment records; this document is the payment-attempt
// record, not the live source of truth for "how much is owed right now."

const mongoose = require('mongoose');

const commissionPaymentSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    property: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Property',
        required: true
    },

    // e.g. "August 2026" — matches the same month-string format Payment.month uses
    month: {
        type:     String,
        required: true
    },

    // Snapshot of total rent collected for this property/month across
    // ALL payment methods (cash, bank, mpesa, other) at calculation time.
    totalCollected: {
        type:     Number,
        required: true
    },

    // Commission rate applied — snapshotted from PlatformSettings at
    // calculation time, so historical records stay accurate even if the
    // stacklord changes the rate later.
    percentage: {
        type:     Number,
        required: true
    },

    // totalCollected * (percentage / 100), rounded up to a whole shilling
    // (Safaricom requires whole-number STK amounts).
    amountDue: {
        type:     Number,
        required: true
    },

    status: {
        type:    String,
        enum:    ['pending', 'paid', 'failed'],
        default: 'pending'
    },

    phone: {
        type: String
    },

    checkoutRequestId: {
        type: String
    },

    merchantRequestId: {
        type: String
    },

    mpesaCode: {
        type: String
    },
    note: { type: String, default: null },

    paidAt: {
        type: Date,
        default: null
    }

}, { timestamps: true });

// One landlord can retry a failed/pending commission payment for the same
// property/month, so no unique index on (property, month) — the summary
// endpoint decides what's still owed based on the most recent 'paid' record,
// not by assuming one document per period.
commissionPaymentSchema.index({ landlord: 1, createdAt: -1 });
commissionPaymentSchema.index({ property: 1, month: 1 });
commissionPaymentSchema.index({ status: 1 });

module.exports = mongoose.model('CommissionPayment', commissionPaymentSchema);