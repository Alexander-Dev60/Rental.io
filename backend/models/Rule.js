// ═══════════════════════════════════════════════════════
//  models/Rule.js — SaaS Multi-tenant version
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════
//  models/Rule.js
// ═══════════════════════════════════════════════════════
const ruleSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // ── Which property this rule belongs to ──
    property: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Property',
        required: true
    },

    title: {
        type:     String,
        required: true,
        trim:     true
    },

    content: {
        type:     String,
        required: true
    }

}, { timestamps: true });

ruleSchema.index({ property: 1, createdAt: -1 });
ruleSchema.index({ landlord: 1, property: 1 });

module.exports = mongoose.model('Rule', ruleSchema);

