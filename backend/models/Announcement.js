const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
    message: {
        type: String,
        required: true,
        trim: true
    }

}, { timestamps: true }); // FIX #5 — timestamps: true instead of manual createdAt

module.exports = mongoose.model('Announcement', announcementSchema);