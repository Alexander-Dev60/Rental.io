// ═══════════════════════════════════════════════════════
//  models/Message.js — SaaS Multi-tenant version
// ════════════════════════════════════════════════
const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════
//  models/Message.js
// ═══════════════════════════════════════════════════════
const messageSchema = new mongoose.Schema({

    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // ── Which property this message belongs to ──
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

    sender: {
        type:     String,
        enum:     ['tenant', 'landlord'],
        required: true
    },

    text: {
        type:     String,
        required: true,
        trim:     true
    },

    isRead: {
        type:    Boolean,
        default: false
    }

}, {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true }
});

messageSchema.index({ property: 1, tenant: 1, createdAt: 1 });
messageSchema.index({ property: 1, isRead: 1 });
messageSchema.index({ landlord: 1, property: 1 });

module.exports = mongoose.model('Message', messageSchema);