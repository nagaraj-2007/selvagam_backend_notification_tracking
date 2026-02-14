const axios = require('axios');
require('dotenv').config();

const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'http://72.61.250.191:8080/api/v1';
const NOTIFICATION_SERVICE_URL = `http://localhost:${process.env.PORT || 10000}/api/v1`;

async function sendToAll() {
    const title = process.argv[2] || "School Notification";
    const message = process.argv[3] || "You have a new update from the school transport system.";

    console.log(`📣 Sending notification to all parents...`);
    console.log(`Title: ${title}`);
    console.log(`Message: ${message}`);

    try {
        const response = await axios.post(`${NOTIFICATION_SERVICE_URL}/notifications/send-all`, {
            title,
            message
        });
        console.log(`✅ Success! Recipients: ${response.data.recipients}`);
    } catch (error) {
        console.error(`❌ Failed: ${error.response?.data?.message || error.message}`);
    }
}

sendToAll();
