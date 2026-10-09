const mongoose = require('mongoose');

const billingSchema = new mongoose.Schema({
  landlord: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  property: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    required: true
  },

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

  billingCycle: {
    type: String,
    enum: ['monthly', 'semester'],
    required: true
  },

  periodLabel: {
    type: String,
    required: true
  },

  amountDue: {
    type: Number,
    required: true,
    min: 0
  },

  dueDate: {
    type: Number,
    default: 5
  },

  dueDateActual: {                    // ← ADD, right after `dueDate`
    type: Date,
    default: null
  },

  status: {
    type: String,
    enum: ['unpaid', 'partial', 'paid'],
    default: 'unpaid'
  },

  paidAmount: {
    type: Number,
    default: 0
  },

  // ── Stay extensions (daily-rate charge beyond the semester's normal end) ──
  extendedEndDate: { type: Date,   default: null },
  extensionDays:   { type: Number, default: 0 },
  extensionCharge: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Billing', billingSchema);