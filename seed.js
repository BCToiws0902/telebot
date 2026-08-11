require('dotenv').config();
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    transactionId: { type: String, required: true, unique: true },
    sellerName: String,
    productName: String,
    proofPhotoId: String, 
    buyerName: String,
    importPrice: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
    durationDays: { type: Number, default: 0 },
    saleDate: { type: Date, default: Date.now },
    refundedAmount: { type: Number, default: 0 },
    notifiedExpiration: { type: Boolean, default: false }
});

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

const URI = process.env.MONGODB_URI;

async function seed() {
    try {
        await mongoose.connect(URI);
        console.log("Connected to MongoDB");

        const dummyData = [
            {
                transactionId: "DH1001",
                sellerName: "Netflix Giá Rẻ",
                productName: "Tài khoản Netflix 1 Tháng",
                proofPhotoId: "",
                buyerName: "Nguyễn Văn A",
                importPrice: 40000,
                price: 75000,
                durationDays: 30,
                saleDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // 5 days ago
            },
            {
                transactionId: "DH1002",
                sellerName: "Spotify Chợ Đen",
                productName: "Tài khoản Spotify 1 Năm",
                proofPhotoId: "",
                buyerName: "Trần Thị B",
                importPrice: 150000,
                price: 250000,
                durationDays: 365,
                saleDate: new Date(Date.now() - 363 * 24 * 60 * 60 * 1000) // 363 days ago -> Hết hạn trong 2 ngày (sắp nhắc gia hạn)
            },
            {
                transactionId: "DH1003",
                sellerName: "Tạp hóa MMO",
                productName: "Youtube Premium",
                proofPhotoId: "",
                buyerName: "Lê Văn C",
                importPrice: 20000,
                price: 35000,
                durationDays: 30,
                saleDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) // 15 days ago
            },
            {
                transactionId: "DH1004",
                sellerName: "Design Tool VN",
                productName: "Canva Pro",
                proofPhotoId: "",
                buyerName: "Phạm Thị D",
                importPrice: 10000,
                price: 30000,
                durationDays: 30,
                saleDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
            },
            {
                transactionId: "DH1005",
                sellerName: "OpenAI Seller",
                productName: "ChatGPT Plus 1 Tháng",
                proofPhotoId: "",
                buyerName: "Đinh Hữu E",
                importPrice: 300000,
                price: 450000,
                durationDays: 30,
                saleDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
            }
        ];

        // Xóa sạch dữ liệu cũ và chèn dữ liệu mới
        await Transaction.deleteMany({});
        console.log("Deleted old transactions");

        await Transaction.insertMany(dummyData);
        console.log("Inserted 5 dummy transactions successfully");

        mongoose.connection.close();
    } catch (e) {
        console.error("Error:", e);
    }
}

seed();
