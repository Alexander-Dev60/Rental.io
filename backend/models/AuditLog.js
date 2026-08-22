const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    landlord: { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true, index: true },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', index: true },
    action:   { type: String, required: true },                 // e.g. 'tenant.created'
    actor:    { type: String, enum: ['landlord', 'system', 'stacklord'], default: 'landlord' },
    message:  { type: String, required: true, maxlength: 300 }, // human-readable, shown in the feed
    meta:     { type: mongoose.Schema.Types.Mixed },             // structured extras, optional
    createdAt: { type: Date, default: Date.now }
});

auditLogSchema.index({ landlord: 1, createdAt: -1 });
auditLogSchema.index({ landlord: 1, property: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);