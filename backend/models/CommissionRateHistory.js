const mongoose = require('mongoose');

const commissionRateHistorySchema = new mongoose.Schema({
    percentage: { type: Number, required: true, min: 0, max: 100 },
    changedBy:  { type: String, default: 'stacklord' },
    changedAt:  { type: Date, default: Date.now }
});

module.exports = mongoose.model('CommissionRateHistory', commissionRateHistorySchema);