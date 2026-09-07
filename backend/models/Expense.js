// ═══════════════════════════════════════════════════════
//  models/Expense.js — SaaS Multi-tenant version
//  Tracks landlord-recorded costs per property/month so the
//  dashboard can show Net Income = Collected − Expenses.
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({

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

    category: {
        type:    String,
        enum:    ['water', 'electricity', 'repairs', 'security', 'cleaning', 'staff', 'other'],
        default: 'other'
    },

    amount: {
        type:     Number,
        required: true,
        min:      [1, 'Expense amount must be greater than 0']
    },

    // Same "May 2026" string format Payment.month uses, so month-based
    // aggregation lines up between the two collections.
    month: {
        type:     String,
        required: true
    },

    note: {
        type:    String,
        default: '',
        trim:    true
    },

    datePaid: {
        type:    Date,
        default: Date.now
    }

}, { timestamps: true });

expenseSchema.index({ property: 1, month: 1 });
expenseSchema.index({ landlord: 1, property: 1 });

module.exports = mongoose.model('Expense', expenseSchema);