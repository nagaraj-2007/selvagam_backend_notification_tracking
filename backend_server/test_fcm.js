const axios = require('axios');
require('dotenv').config();

const NOTIFICATION_SERVICE_URL = `http://localhost:${process.env.PORT || 10000}/api/v1`;

async function testFCM() {
    const routeId = process.argv[2];
    if (!routeId) {
        console.log("Usage: node test_fcm.js <route_id>");
        process.exit(1);
    }

    console.log(`🚀 Sending test FCM notification to route: ${routeId}`);

    try {
        const response = await axios.post(`${NOTIFICATION_SERVICE_URL}/notifications/test-route`, {
            route_id: routeId,
            title: "Test Bus Notification",
            message: "This is a test notification to verify your device registration."
        });
        console.log(`✅ Success! Sent to ${response.data.tokens_count} tokens.`);
    } catch (error) {
        console.error(`❌ Failed: ${error.response?.data?.message || error.message}`);
    }
}

testFCM();
