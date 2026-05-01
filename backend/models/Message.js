const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    tenant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tenant',
        required: true
    },

    sender: {
        type: String,
        enum: ['tenant', 'admin'], // FIX #6 — validated enum
        required: true
    },

    text: {           // FIX #3 — consistent field name (was saved as "message" in server.js)
        type: String,
        required: true,
        trim: true
    },

    isRead: {
        type: Boolean,
        default: false
    }

}, { timestamps: true }); // FIX #5 — use timestamps instead of manual createdAt

// FIX #1 — was completely missing
module.exports = mongoose.model('Message', messageSchema);