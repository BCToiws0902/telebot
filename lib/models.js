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
    status: { type: String, enum: ['NORMAL', 'WARRANTY_REQUESTED', 'REFUNDED'], default: 'NORMAL' },
    notifiedExpiration: { type: Boolean, default: false }
});

const sessionSchema = new mongoose.Schema({
    userId: Number,
    state: String,
    data: { type: Object, default: {} },
    lastMessages: { type: Array, default: [] },
    chatHistory: { type: Array, default: [] }
});

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
});

const pcCommandSchema = new mongoose.Schema({
    command: { type: String, required: true },
    status: { type: String, default: 'PENDING' },
    createdAt: { type: Date, default: Date.now },
    result: { type: String }
});

const noteSchema = new mongoose.Schema({
    content: { type: String, required: false }, // Cho phép rỗng nếu chỉ có ảnh
    category: { type: String, required: true },
    fileId: { type: String },
    fileType: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const expenseSchema = new mongoose.Schema({
    type: { type: String, enum: ['INCOME', 'EXPENSE'], required: true },
    amount: { type: Number, required: true },
    category: { type: String, default: 'Khác' },
    note: { type: String },
    date: { type: Date, default: Date.now }
});

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);
const PcCommand = mongoose.models.PcCommand || mongoose.model('PcCommand', pcCommandSchema);
const Note = mongoose.models.Note || mongoose.model('Note', noteSchema);
const Expense = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);

module.exports = { Transaction, Session, Config, PcCommand, Note, Expense };
