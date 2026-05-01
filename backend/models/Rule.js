const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },

    content: {
        type: String,
        required: true,
        trim: true
    }

}, { timestamps: true }); // FIX #5 — timestamps: true instead of manual createdAt

module.exports = mongoose.model('Rule', ruleSchema);