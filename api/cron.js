const fetch = require('node-fetch'); // In Node 18, fetch is global, but Vercel Node env might need it or global is fine. Node 18+ global fetch is available.
const connectDB = require('../lib/db');
const { Transaction, Config } = require('../lib/models');

module.exports = async (req, res) => {
    try {
        await connectDB();
        
        const ownerConf = await Config.findOne({ key: 'ownerId' });
        if (!ownerConf) return res.status(200).send('No owner setup yet.');
        
        const ownerId = ownerConf.value;
        const botToken = process.env.BOT_TOKEN;
        
        // Tìm các đơn hàng chưa thông báo, và còn <= 3 ngày là hết hạn
        const allTx = await Transaction.find({ notifiedExpiration: false });
        const currentDate = new Date();
        
        let count = 0;
        for (let tx of allTx) {
            if (tx.durationDays > 0) {
                const saleDate = new Date(tx.saleDate);
                const expiryDate = new Date(saleDate.getTime() + (tx.durationDays * 24 * 60 * 60 * 1000));
                
                const diffTime = expiryDate.getTime() - currentDate.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                
                if (diffDays >= 0 && diffDays <= 3) {
                    // Cần gia hạn
                    const msg = `🔔 BÁO ĐỘNG GIA HÀN:\n\nKhách hàng [${tx.buyerName}] sắp hết hạn dịch vụ [${tx.productName}] (Mã: ${tx.transactionId}).\nCòn lại: ${diffDays} ngày.\nHãy nhắn tin cho khách để mời gia hạn nhé!`;
                    
                    // Gửi tin nhắn qua Telegram API
                    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: ownerId,
                            text: msg
                        })
                    });
                    
                    // Đánh dấu đã thông báo
                    await Transaction.updateOne({ transactionId: tx.transactionId }, { notifiedExpiration: true });
                    count++;
                }
            }
        }
        
        res.status(200).send(`Cron executed. Notified ${count} orders.`);
    } catch (e) {
        console.error('Lỗi Cron:', e);
        res.status(500).send('Error');
    }
};
