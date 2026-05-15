const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

require("dotenv").config();

const User = require("./models/User");
const connectDB = require("./db");

// ─────────────────────────────────────────────
// STACKLORD ADMIN SEEDER
// ─────────────────────────────────────────────

async function createAdmin() {
    try {

        // ── Connect Database ──
        await connectDB();

        console.log("🟢 Database connected");

        // ── Check Existing Admin ──
        const exists = await User.findOne({
            email: "admin@system.com"
        });

        if (exists) {
            console.log("⚠️ Admin already exists");
            process.exit(0);
        }

        // ── Hash Password ──
        const hashed = await bcrypt.hash("Alex33366763#", 10);

        // ── Create Admin ──
        const admin = await User.create({
            name: "Stacklord Admin",
            email: "admin@system.com",
            password: hashed,
            role: "admin",

            // ── Subscription Defaults ──
            subscriptionStatus: "trial",

            trialEndsAt: new Date(
                Date.now() + 14 * 24 * 60 * 60 * 1000
            ),

            subscriptionExpiry: null,
            gracePeriodUntil: null,

            landlordPhone: "254700000000",

            suspendedReason: null,
            suspendedAt: null,
            suspendedBy: null
        });

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("✅ Admin created successfully");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("Name:", admin.name);
        console.log("Email:", admin.email);
        console.log("Role:", admin.role);
        console.log("Plan Status:", admin.subscriptionStatus);
        console.log("Trial Ends:", admin.trialEndsAt);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━");

        process.exit(0);

    } catch (error) {

        console.error("❌ Failed to create admin");
        console.error(error);

        process.exit(1);

    } finally {

        await mongoose.connection.close();

    }
}

createAdmin();