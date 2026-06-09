// ═══════════════════════════════════════════════════════
//  models/Announcement.js — SaaS Multi-tenant version
// ═══════════════════════════════════════════════════════
const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════
//  models/Announcement.js
// ═══════════════════════════════════════════════════════
const announcementSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // ── Which property this announcement belongs to ──
    property: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Property',
        required: true
    },

    message: {
        type:     String,
        required: true
    }

}, { timestamps: true });

announcementSchema.index({ property: 1, createdAt: -1 });
announcementSchema.index({ landlord: 1, property: 1 });

module.exports = mongoose.model('Announcement', announcementSchema);