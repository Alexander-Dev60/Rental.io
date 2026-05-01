// models/Settings.js
// Single-document collection for system-wide settings
// Only one document ever exists — we use findOneAndUpdate with upsert

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
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

module.exports = mongoose.model('Settings', settingsSchema);