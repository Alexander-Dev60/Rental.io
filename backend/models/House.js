const mongoose = require('mongoose');

const houseSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },

    rent: {
        type: Number,
        required: true
    },

    status: {
        type: String,
        enum: ['available', 'occupied'],
        default: 'available'
    }

}, { timestamps: true });

module.exports = mongoose.model('House', houseSchema);