// ═══════════════════════════════════════════════════════
//  models/Inquiry.js
//  Prospective tenant inquiries submitted from public
//  listings page — no auth required to create.
// ═══════════════════════════════════════════════════════

const mongoose = require('mongoose');

const inquirySchema = new mongoose.Schema({

    // Which property the inquiry is about
    property: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Property',
        required: true
    },

    // Landlord who owns that property (denormalised for fast dashboard queries)
    landlord: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },

    // Prospective tenant details — no account required
    name: {
        type:     String,
        required: true,
        trim:     true
    },

    phone: {
        type:     String,
        required: true,
        trim:     true
    },

    email: {
        type:    String,
        trim:    true,
        lowercase: true,
        default: null
    },

    message: {
        type:    String,
        trim:    true,
        default: ''
    },

    // Landlord workflow
    status: {
        type:    String,
        enum:    ['new', 'read', 'contacted', 'archived'],
        default: 'new'
    },

    
    // Optional landlord notes
    notes: {
        type:    String,
        trim:    true,
        default: ''
    }

}, { timestamps: true });

// Fast dashboard queries: landlord's unread/new inquiries
inquirySchema.index({ landlord: 1, status: 1, createdAt: -1 });
inquirySchema.index({ property: 1, createdAt: -1 });

module.exports = mongoose.model('Inquiry', inquirySchema);