const express = require('express');
const axios = require('axios');
const geolib = require('geolib');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const MAIN_BACKEND_URL = process.env.MAIN_BACKEND_URL || 'http://72.61.250.191:8080/api/v1';
const GEOFENCE_RADIUS = parseInt(process.env.GEOFENCE_RADIUS) || 500; // meters - distance to trigger "bus approaching" notification

// Initialize Firebase Admin SDK
// TODO: Replace with your Firebase service account credentials
try {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        })
    });
    console.log('✅ Firebase Admin initialized');
} catch (error) {
    console.warn('⚠️ Firebase Admin not initialized. Notifications will be logged only.');
    console.warn('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in .env');
}

// In-memory store for active trips
const activeTrips = new Map();
const notifiedStops = new Map(); // Track which stops have been notified

// Helper: Send FCM Notification
async function sendFCMNotification(tokens, title, body, data = {}) {
    if (!tokens || tokens.length === 0) {
        console.log('No tokens to send notification to');
        return;
    }

    console.log(`📤 Sending notification to ${tokens.length} parents: "${title}"`);

    try {
        if (admin.apps.length > 0) {
            // Convert all data values to strings (FCM requirement)
            const stringData = {};
            for (const [key, value] of Object.entries(data)) {
                stringData[key] = String(value);
            }

            const message = {
                notification: { 
                    title, 
                    body 
                },
                data: stringData,
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'bus_tracking_channel',
                        priority: 'high',
                        sound: 'default',
                        visibility: 'public'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1
                        }
                    }
                }
            };

            // Send to multiple tokens
            const promises = tokens.map(token =>
                admin.messaging().send({ ...message, token })
                    .catch(err => console.error(`Failed to send to ${token}:`, err.message))
            );

            await Promise.all(promises);
            console.log('✅ Notifications sent successfully');
        } else {
            console.log(`📝 [MOCK] Notification: ${title} - ${body}`);
        }
    } catch (error) {
        console.error('Error sending FCM notification:', error.message);
    }
}

// Helper: Fetch ALL FCM tokens
async function fetchAllTokens() {
    try {
        const response = await axios.get(`${MAIN_BACKEND_URL}/fcm-tokens/all`);
        const data = response.data;
        
        // Extract token strings from objects returned by the backend
        if (data.parents && Array.isArray(data.parents)) {
            return data.parents
                .map(item => item.fcm_token)
                .filter(token => token && typeof token === 'string');
        }
        
        // Fallback for flat array structure
        if (Array.isArray(data)) {
            return data
                .map(item => item.fcm_token || item.token || item)
                .filter(token => token && typeof token === 'string');
        }
        return [];
    } catch (error) {
        console.error('Error fetching all FCM tokens:', error.message);
        return [];
    }
}

// Helper: Fetch route stops from main backend
async function fetchRouteStops(routeId) {
    try {
        const response = await axios.get(`${MAIN_BACKEND_URL}/route-stops?route_id=${routeId}`);
        return response.data.sort((a, b) => a.pickup_stop_order - b.pickup_stop_order);
    } catch (error) {
        console.error(`Error fetching stops for route ${routeId}:`, error.message);
        return [];
    }
}

// Helper: Fetch tokens for a specific stop
async function fetchTokensAtStop(stopId) {
    try {
        const response = await axios.get(`${MAIN_BACKEND_URL}/fcm-tokens/by-stop/${stopId}`);
        if (response.data && response.data.fcm_tokens) {
            return response.data.fcm_tokens
                .map(t => t.fcm_token)
                .filter(token => token && typeof token === 'string');
        }
        return [];
    } catch (error) {
        console.error(`Error fetching tokens for stop ${stopId}:`, error.message);
        return [];
    }
}

// Helper: Fetch students for a specific stop (unused but fixed)
async function fetchStudentsAtStop(stopId) {
    try {
        // Backend doesn't have students/by-stop, it has fcm-tokens/by-stop which returns students too
        const response = await axios.get(`${MAIN_BACKEND_URL}/fcm-tokens/by-stop/${stopId}`);
        return response.data.students || []; 
    } catch (error) {
        console.error(`Error fetching students for stop ${stopId}:`, error.message);
        return [];
    }
}

// Helper: Fetch FCM tokens by route
async function fetchTokensByRoute(routeId) {
    try {
        const response = await axios.get(`${MAIN_BACKEND_URL}/fcm-tokens/by-route/${routeId}`);
        const data = response.data;
        
        console.log('Raw API response:', JSON.stringify(data, null, 2));
        
        // Handle nested structure with stops
        if (data.stops && Array.isArray(data.stops)) {
            const tokens = [];
            for (const stop of data.stops) {
                if (stop.fcm_tokens && Array.isArray(stop.fcm_tokens)) {
                    for (const tokenObj of stop.fcm_tokens) {
                        const token = tokenObj.fcm_token || tokenObj.token;
                        if (token && typeof token === 'string') {
                            tokens.push(token);
                        }
                    }
                }
            }
            // Remove duplicates
            return [...new Set(tokens)];
        }
        
        // Fallback: flat array structure
        if (Array.isArray(data)) {
            return data
                .map(item => item.fcm_token || item.token || item)
                .filter(token => token && typeof token === 'string');
        }
        
        return [];
    } catch (error) {
        console.error('Error fetching FCM tokens:', error.message);
        return [];
    }
}

// Helper: Fetch parent FCM tokens
async function fetchParentTokens(parentIds) {
    try {
        const tokens = [];
        for (const parentId of parentIds) {
            const response = await axios.get(`${MAIN_BACKEND_URL}/parents/${parentId}`);
            if (response.data && response.data.fcm_token) {
                tokens.push(response.data.fcm_token);
            }
        }
        return tokens;
    } catch (error) {
        console.error('Error fetching parent tokens:', error.message);
        return [];
    }
}

// ============================================
// API ENDPOINT: Update Bus Location
// ============================================
app.post('/api/v1/bus-tracking/location', async (req, res) => {
    const { trip_id, latitude, longitude, timestamp } = req.body;

    if (!trip_id || !latitude || !longitude) {
        return res.status(400).json({ error: 'Missing required fields: trip_id, latitude, longitude' });
    }

    console.log(`📍 Location update for trip ${trip_id}: ${latitude}, ${longitude}`);

    try {
        // Get or initialize trip data
        if (!activeTrips.has(trip_id)) {
            // Fetch trip details
            const tripResponse = await axios.get(`${MAIN_BACKEND_URL}/trips/${trip_id}`);
            const trip = tripResponse.data;

            // Fetch route stops
            const stops = await fetchRouteStops(trip.route_id);

            activeTrips.set(trip_id, {
                tripId: trip_id,
                routeId: trip.route_id,
                stops: stops,
                currentStopIndex: -1,
                status: 'ONGOING'
            });

            notifiedStops.set(trip_id, new Set());

            console.log(`✅ Initialized trip ${trip_id} with ${stops.length} stops`);

            // Send trip started notification ONLY IF not already sent by start endpoint
            const tokens = await fetchTokensByRoute(trip.route_id);
            if (tokens.length > 0) {
                await sendFCMNotification(
                    tokens,
                    '🚌 Bus Started',
                    `Bus has started the trip`,
                    { trip_id, route_id: trip.route_id, status: 'STARTED' }
                );
            }
        }

        const tripData = activeTrips.get(trip_id);
        const currentLocation = { latitude, longitude };

        // Check distance to each stop
        for (let i = 0; i < tripData.stops.length; i++) {
            const stop = tripData.stops[i];
            const stopLocation = {
                latitude: stop.latitude,
                longitude: stop.longitude
            };

            const distance = geolib.getDistance(currentLocation, stopLocation);

            // Check if bus is within geofence radius
            if (distance <= GEOFENCE_RADIUS) {
                const stopKey = `${trip_id}-${stop.stop_id}`;

                // Only notify once per stop
                if (!notifiedStops.get(trip_id).has(stopKey)) {
                    console.log(`🎯 Bus reached stop: ${stop.stop_name} (${distance}m away)`);

                    // Mark stop as notified
                    notifiedStops.get(trip_id).add(stopKey);
                    tripData.currentStopIndex = i;

                    // Get FCM tokens for this stop efficiently
                    const currentStopTokens = await fetchTokensAtStop(stop.stop_id);
                    
                    // Send notification to current stop parents
                    if (currentStopTokens.length > 0) {
                        await sendFCMNotification(
                            currentStopTokens,
                            '🚌 Bus Approaching',
                            `The bus is 500m away from ${stop.stop_name} and will arrive in a few minutes`,
                            {
                                trip_id: trip_id,
                                stop_name: stop.stop_name,
                                stop_id: stop.stop_id,
                                distance: distance.toString(),
                                type: 'approaching'
                            }
                        );
                    }

                    // Notify next stop parents that bus reached current stop
                    if (i + 1 < tripData.stops.length) {
                        const nextStop = tripData.stops[i + 1];
                        const nextStopTokens = await fetchTokensAtStop(nextStop.stop_id);

                        if (nextStopTokens.length > 0) {
                            await sendFCMNotification(
                                nextStopTokens,
                                '🚌 Bus Update',
                                `Bus has reached ${stop.stop_name}. Your stop ${nextStop.stop_name} is next`,
                                {
                                    trip_id: trip_id,
                                    stop_name: nextStop.stop_name,
                                    stop_id: nextStop.stop_id,
                                    previous_stop: stop.stop_name,
                                    type: 'next_stop'
                                }
                            );
                        }
                    }
                }
            }
        }

        // Check if trip is completed (reached last stop)
        if (tripData.currentStopIndex === tripData.stops.length - 1) {
            console.log(`✅ Trip ${trip_id} completed`);
            tripData.status = 'COMPLETED';

            // Update trip status in main backend
            await axios.patch(`${MAIN_BACKEND_URL}/trips/${trip_id}/status`, {
                status: 'COMPLETED'
            });

            // Send trip completed notification
            const tokens = await fetchTokensByRoute(tripData.routeId);
            if (tokens.length > 0) {
                await sendFCMNotification(
                    tokens,
                    '✅ Trip Completed',
                    `Bus has completed the trip`,
                    { trip_id, route_id: tripData.routeId, status: 'COMPLETED' }
                );
            }
        }

        res.json({
            success: true,
            trip_id: trip_id,
            current_stop_index: tripData.currentStopIndex,
            total_stops: tripData.stops.length,
            status: tripData.status
        });

    } catch (error) {
        console.error('Error processing location update:', error.message);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// ============================================
// API ENDPOINT: Send Notifications to Tokens
// ============================================
app.post('/api/v1/notifications/send', async (req, res) => {
    const { tokens, title, message, data } = req.body;

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid tokens array' });
    }

    if (!title || !message) {
        return res.status(400).json({ error: 'Missing required fields: title, message' });
    }

    try {
        await sendFCMNotification(tokens, title, message, data || {});
        res.json({ success: true, recipients: tokens.length });
    } catch (error) {
        console.error('Error sending notifications:', error.message);
        res.status(500).json({ error: 'Failed to send notifications', message: error.message });
    }
});

// ============================================
// API ENDPOINT: Send Custom Notification
// ============================================
app.post('/api/v1/bus-tracking/notify', async (req, res) => {
    const { trip_id, message, stop_id } = req.body;

    if (!trip_id || !message) {
        return res.status(400).json({ error: 'Missing required fields: trip_id, message' });
    }

    try {
        let tokens = [];

        if (stop_id) {
            // Send to specific stop parents
            tokens = await fetchTokensAtStop(stop_id);
        } else {
            // Send to all parents on the route
            const tripData = activeTrips.get(trip_id);
            if (tripData) {
                const routeTokens = await fetchTokensByRoute(tripData.routeId);
                tokens.push(...routeTokens);
            }
        }

        await sendFCMNotification(
            [...new Set(tokens)], // Remove duplicates
            'Bus Update',
            message,
            { trip_id, custom: 'true' }
        );

        res.json({ success: true, recipients: tokens.length });

    } catch (error) {
        console.error('Error sending custom notification:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// API ENDPOINT: Test FCM Notification by Route
// ============================================
app.post('/api/v1/notifications/test-route', async (req, res) => {
    const { route_id, title, message } = req.body;

    if (!route_id) {
        return res.status(400).json({ error: 'Missing required field: route_id' });
    }

    try {
        const tokens = await fetchTokensByRoute(route_id);
        
        if (tokens.length === 0) {
            return res.status(404).json({ error: 'No FCM tokens found for this route' });
        }

        await sendFCMNotification(
            tokens,
            title || '🚌 Test Notification',
            message || 'This is a test notification from your bus tracking system',
            { route_id, test: 'true' }
        );

        res.json({ success: true, tokens_count: tokens.length, tokens });
    } catch (error) {
        console.error('Error sending test notification:', error.message);
        res.status(500).json({ error: 'Failed to send notification', message: error.message });
    }
});

// ============================================
// API ENDPOINT: Send Notification to All Parents
// ============================================
app.post('/api/v1/notifications/send-all', async (req, res) => {
    const { title, message, data } = req.body;

    try {
        const tokens = await fetchAllTokens();

        if (!tokens || tokens.length === 0) {
            return res.status(404).json({ error: 'No FCM tokens found' });
        }

        await sendFCMNotification(
            tokens,
            title || '🚌 Notification',
            message || 'You have a new notification',
            data || {}
        );

        res.json({ success: true, recipients: tokens.length });
    } catch (error) {
        console.error('Error sending to all:', error.message);
        res.status(500).json({ error: 'Failed to send notifications', message: error.message });
    }
});

// ============================================
// API ENDPOINT: Notify Trip Status Change
// ============================================
app.post('/api/v1/notifications/trip-status', async (req, res) => {
    const { trip_id, status } = req.body;

    if (!trip_id || !status) {
        return res.status(400).json({ error: 'Missing required fields: trip_id, status' });
    }

    try {
        // Fetch trip details
        const tripResponse = await axios.get(`${MAIN_BACKEND_URL}/trips/${trip_id}`);
        const trip = tripResponse.data;

        // Fetch tokens for this route
        const tokens = await fetchTokensByRoute(trip.route_id);

        if (tokens.length === 0) {
            return res.status(404).json({ error: 'No FCM tokens found for this route' });
        }

        // Prepare notification based on status
        let title, message;
        
        switch(status.toUpperCase()) {
            case 'STARTED':
                title = '🚌 Bus Started';
                message = `Bus has started the trip on Route ${trip.route_id}`;
                break;
            case 'ONGOING':
                title = '🚌 Bus On Route';
                message = `Bus is currently on the way`;
                break;
            case 'COMPLETED':
                title = '✅ Trip Completed';
                message = `Bus has completed the trip`;
                break;
            case 'CANCELLED':
                title = '❌ Trip Cancelled';
                message = `Trip has been cancelled. Please check for updates.`;
                break;
            case 'DELAYED':
                title = '⏰ Bus Delayed';
                message = `Bus is running late. We apologize for the inconvenience.`;
                break;
            default:
                title = '🚌 Trip Update';
                message = `Trip status: ${status}`;
        }

        await sendFCMNotification(
            tokens,
            title,
            message,
            { trip_id, status, route_id: trip.route_id }
        );

        res.json({ success: true, recipients: tokens.length, status });
    } catch (error) {
        console.error('Error sending trip status notification:', error.message);
        res.status(500).json({ error: 'Failed to send notification', message: error.message });
    }
});

// ============================================
// API ENDPOINT: Start Trip with Notification
// ============================================
app.post('/api/v1/trip/start', async (req, res) => {
    const { trip_id, route_id } = req.body;

    if (!trip_id || !route_id) {
        return res.status(400).json({ error: 'Missing required fields: trip_id, route_id' });
    }

    try {
        console.log(`\n========== START TRIP ==========`);
        console.log(`Trip: ${trip_id}, Route: ${route_id}`);
        
        // Initialize trip data if not already initialized
        if (!activeTrips.has(trip_id)) {
            const stops = await fetchRouteStops(route_id);
            activeTrips.set(trip_id, {
                tripId: trip_id,
                routeId: route_id,
                stops: stops,
                currentStopIndex: -1,
                status: 'STARTED'
            });
            notifiedStops.set(trip_id, new Set());
            console.log(`Initialized trip data for ${trip_id}`);
        }

        const tokens = await fetchTokensByRoute(route_id);
        console.log(`Found ${tokens.length} tokens`);
        
        if (tokens.length > 0) {
            await sendFCMNotification(
                tokens,
                '🚌 Bus Started',
                'Your bus has started the trip',
                { trip_id, route_id, status: 'STARTED' }
            );
        }
        console.log(`================================\n`);

        res.json({ success: true, recipients: tokens.length, status: 'STARTED' });
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: 'Failed to start trip', message: error.message });
    }
});

// ============================================
// API ENDPOINT: Pause Trip with Notification
// ============================================
app.post('/api/v1/trip/pause', async (req, res) => {
    const { trip_id, route_id } = req.body;

    if (!trip_id || !route_id) {
        return res.status(400).json({ error: 'Missing required fields: trip_id, route_id' });
    }

    try {
        const tokens = await fetchTokensByRoute(route_id);
        
        if (tokens.length > 0) {
            await sendFCMNotification(
                tokens,
                '⏸️ Bus Paused',
                'Your bus has paused temporarily',
                { trip_id, route_id, status: 'PAUSED' }
            );
        }

        res.json({ success: true, recipients: tokens.length, status: 'PAUSED' });
    } catch (error) {
        console.error('Error pausing trip:', error.message);
        res.status(500).json({ error: 'Failed to pause trip', message: error.message });
    }
});

// ============================================
// API ENDPOINT: Complete Trip with Notification
// ============================================
app.post('/api/v1/trip/complete', async (req, res) => {
    const { trip_id, route_id } = req.body;

    if (!trip_id || !route_id) {
        return res.status(400).json({ error: 'Missing required fields: trip_id, route_id' });
    }

    try {
        const tokens = await fetchTokensByRoute(route_id);
        
        if (tokens.length > 0) {
            await sendFCMNotification(
                tokens,
                '✅ Trip Completed',
                'Your bus has completed the trip',
                { trip_id, route_id, status: 'COMPLETED' }
            );
        }

        // Clean up trip data
        activeTrips.delete(trip_id);
        notifiedStops.delete(trip_id);

        res.json({ success: true, recipients: tokens.length, status: 'COMPLETED' });
    } catch (error) {
        console.error('Error completing trip:', error.message);
        res.status(500).json({ error: 'Failed to complete trip', message: error.message });
    }
});

// ============================================
// Health Check Endpoint
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        active_trips: activeTrips.size,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// TEST: Check tokens for route
// ============================================
app.get('/api/v1/test/tokens/:route_id', async (req, res) => {
    const { route_id } = req.params;
    try {
        console.log(`Testing token fetch for route: ${route_id}`);
        const response = await axios.get(`${MAIN_BACKEND_URL}/fcm-tokens/by-route/${route_id}`);
        console.log('API Response:', response.data);
        res.json({ 
            route_id, 
            raw_response: response.data,
            token_count: Array.isArray(response.data) ? response.data.length : 0
        });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// TEST: Simulate bus location for testing
// ============================================
app.post('/api/v1/test/simulate-location', async (req, res) => {
    const { trip_id, stop_index } = req.body;
    
    try {
        // Get trip data
        const tripResponse = await axios.get(`${MAIN_BACKEND_URL}/trips/${trip_id}`);
        const trip = tripResponse.data;
        
        // Get stops
        const stops = await fetchRouteStops(trip.route_id);
        
        if (stop_index >= stops.length) {
            return res.status(400).json({ error: 'Invalid stop index' });
        }
        
        const targetStop = stops[stop_index];
        
        // Simulate location 400m away from stop (within 500m geofence)
        const simulatedLat = targetStop.latitude + 0.0036; // ~400m north
        const simulatedLng = targetStop.longitude;
        
        console.log(`\n🧪 SIMULATING LOCATION`);
        console.log(`Target Stop: ${targetStop.stop_name}`);
        console.log(`Stop Location: ${targetStop.latitude}, ${targetStop.longitude}`);
        console.log(`Simulated Bus Location: ${simulatedLat}, ${simulatedLng}`);
        
        // Send to location endpoint
        const locationResponse = await axios.post(`http://localhost:${PORT}/api/v1/bus-tracking/location`, {
            trip_id,
            latitude: simulatedLat,
            longitude: simulatedLng,
            timestamp: new Date().toISOString()
        });
        
        res.json({
            success: true,
            message: 'Location simulated',
            stop: targetStop.stop_name,
            simulated_location: { lat: simulatedLat, lng: simulatedLng },
            actual_stop: { lat: targetStop.latitude, lng: targetStop.longitude },
            response: locationResponse.data
        });
    } catch (error) {
        console.error('Error simulating location:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Bus Tracking Service running on port ${PORT}`);
    console.log(`📡 Main Backend: ${MAIN_BACKEND_URL}`);
    console.log(`📍 Geofence Radius: ${GEOFENCE_RADIUS}m`);
});
