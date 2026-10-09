const mongoose = require('mongoose');

const tenantInvitationSchema = new mongoose.Schema({
    code:      { type: String, required: true, unique: true },
    landlord:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
    property:  { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    status:    { type: String, enum: ['active', 'revoked'], default: 'active' },
    expiresAt: { type: Date, default: null },     // null = no expiry
    usedCount: { type: Number, default: 0 },
    revokedAt: { type: Date, default: null }
}, { timestamps: true });

tenantInvitationSchema.index({ property: 1, status: 1 });

module.exports = mongoose.model('TenantInvitation', tenantInvitationSchema);