// ═══════════════════════════════════════════════════════
//  models/Settings.js — SaaS Multi-tenant version
//  One settings doc per landlord (not global anymore)
// ═══════════════════════════════════════════════════════
const mongoose = require('mongoose');
// ═══════════════════════════════════════════════════════
//  models/Settings.js
// ═══════════════════════════════════════════════════════
const settingsSchema = new mongoose.Schema({

    // unique: true here is fine — no schema.index() below, so no duplicate
    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true,
        unique:   true  // one settings doc per landlord
    },

    maintenanceMode: {
        type:    Boolean,
        default: false
    },

    maintenanceMessage: {
        type:    String,
        default: 'The system is currently under maintenance. Please check back later.'
    },

    updatedAt: {
        type:    Date,
        default: Date.now
    }

});

// No schema.index() here — unique: true above is the only index

module.exports = mongoose.model('Settings', settingsSchema);

