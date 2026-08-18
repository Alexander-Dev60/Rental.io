// ═══════════════════════════════════════════════════════
//  models/CommissionRateHistory.js
//  Append-only log of every commission rate change the stacklord makes.
//  PlatformSettings only ever holds the CURRENT rate — this is what lets
//  the admin console show "5% until March, then raised to 7%" instead of
//  just the latest number.
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const commissionRateHistorySchema = new mongoose.Schema({
    percentage: { type: Number, required: true },
    changedBy:  { type: String, default: 'stacklord' },
    changedAt:  { type: Date, default: Date.now }
});

module.exports = mongoose.model('CommissionRateHistory', commissionRateHistorySchema);