require('dotenv').config();
const mongoose = require('mongoose');
const { PcCommand, Config } = require('./lib/models');
const URI = process.env.MONGODB_URI;

async function check() {
    await mongoose.connect(URI);
    const owner = await Config.findOne({ key: 'ownerId' });
    console.log("OwnerId:", owner ? owner.value : 'Not found');
    const cmds = await PcCommand.find({}).sort({ createdAt: -1 }).limit(5);
    console.log("Recent commands:", cmds);
    process.exit(0);
}
check();
