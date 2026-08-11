require('dotenv').config();
const mongoose = require('mongoose');
const { Config } = require('./lib/models');

const URI = process.env.MONGODB_URI;

async function run() {
    await mongoose.connect(URI);
    await Config.deleteMany({});
    console.log('Cleared owner config');
    mongoose.connection.close();
}
run();
