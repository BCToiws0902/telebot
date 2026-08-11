const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
    if (isConnected) return;
    if (!process.env.MONGODB_URI) {
        console.error('Thiếu biến môi trường MONGODB_URI');
        return;
    }
    try {
        const db = await mongoose.connect(process.env.MONGODB_URI);
        isConnected = db.connections[0].readyState;
        console.log('Đã kết nối MongoDB');
    } catch (error) {
        console.error('Lỗi kết nối MongoDB:', error);
    }
};

module.exports = connectDB;
