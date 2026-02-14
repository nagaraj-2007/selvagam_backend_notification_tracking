const axios = require('axios');
require('dotenv').config();

const NOTIFICATION_SERVICE_URL = `http://localhost:${process.env.PORT || 10000}/api/v1`;

async function testTokens() {
    const routeId = process.argv[2];
    if (!routeId) {
        console.log("Usage: node test_tokens.js <route_id>");
        process.exit(1);
    }

    console.log(`🔍 Testing token fetch for route: ${routeId}`);

    try {
        const response = await axios.get(`${NOTIFICATION_SERVICE_URL}/test/tokens/${routeId}`);
        console.log(`\nResults:`);
        console.log(`- Token Count: ${response.data.token_count}`);
        console.log(`- Raw Data:`, JSON.stringify(response.data.raw_response, null, 2));
    } catch (error) {
        console.error(`❌ Error: ${error.response?.data?.error || error.message}`);
    }
}

testTokens();
