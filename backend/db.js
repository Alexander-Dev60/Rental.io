const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect('mongodb://127.0.0.1:27017/rental_system');
       
        

        console.log("MongoDB connected 🚀");
    } catch (error) {
        console.log("DB connection failed ❌", error);
        process.exit(1);
    }
};

module.exports = connectDB;