const mongoose = require('mongoose');

const connectDB = async () => {
    try {        
        
        
       await mongoose.connect(process.env.MONGO_URI);
          
        
        console.log("MongoDB connected 🚀");
    } catch (error) {
        console.log("DB connection failed ❌", error);
        process.exit(1);
    }
};
//await mongoose.connect('mongodb://127.0.0.1:27017/rental_system'); 
module.exports = connectDB;
