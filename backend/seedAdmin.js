const bcrypt = require("bcryptjs");
const User = require("./models/User");
require('dotenv').config();
const connectDB = require('./db');
connectDB();




async function createAdmin() {
    const exists = await User.findOne({ email: "admin@system.com" });

    if (exists) {
        console.log("Admin already exists");
        return;
    }

    const hashed = await bcrypt.hash("Alex33366763#", 10);

    await User.create({
        name: "Admin",
        email: "admin@system.com",
        password: hashed,
        role: "admin"
    });

    console.log("Admin created ✅");
    process.exit();
}

createAdmin();