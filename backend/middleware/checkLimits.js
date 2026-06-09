// middleware/checkLimits.js

const checkPropertyLimit = async (req, res, next) => {
    const landlord = await User.findById(req.user.id)
        .populate('subscriptionPlan');

    const plan = landlord.subscriptionPlan;
    if (!plan) return res.status(403).json({ message: 'No active plan found' });

    // -1 means unlimited
    if (plan.maxProperties === -1) return next();

    const propertyCount = await Property.countDocuments({ landlord: req.user.id });

    if (propertyCount >= plan.maxProperties) {
        return res.status(403).json({
            message:  `Your ${plan.name} plan allows ${plan.maxProperties} ${plan.maxProperties === 1 ? 'property' : 'properties'}. Upgrade to add more.`,
            upgrade:  true   // frontend uses this to show upgrade prompt
        });
    }

    next();
};

const checkTenantLimit = async (req, res, next) => {
    const landlord = await User.findById(req.user.id)
        .populate('subscriptionPlan');

    const plan = landlord.subscriptionPlan;
    if (!plan) return res.status(403).json({ message: 'No active plan found' });

    if (plan.maxTenantsPerProperty === -1) return next();

    // Count active tenants under this landlord
    const tenantCount = await Tenant.countDocuments({ landlord: req.user.id });

    if (tenantCount >= plan.maxTenantsPerProperty) {
        return res.status(403).json({
            message: `Your ${plan.name} plan allows ${plan.maxTenantsPerProperty} tenants. Upgrade to add more.`,
            upgrade: true
        });
    }

    next();
};

module.exports = { checkPropertyLimit, checkTenantLimit };