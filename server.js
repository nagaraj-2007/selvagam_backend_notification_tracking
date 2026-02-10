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
const GEOFENCE_RADIUS = parseInt(process.env.GEOFENCE_RADIUS) || 100; // meters - distance to trigger "bus arrived" notification

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
            const message = {
                notification: { title, body },
                data: data,
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

// Helper: Fetch students for a specific stop
async function fetchStudentsAtStop(stopId) {
    try {
        const response = await axios.get(`${MAIN_BACKEND_URL}/students/by-route/${stopId}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching students for stop ${stopId}:`, error.message);
        return [];
    }
}

// Helper: Fetch FCM tokens by route
async function fetchTokensByRoute(routeId) {
    try {
        const response = await axios.get(`${MAIN_BACKEND_URL}/fcm-tokens/by-route/${routeId}`);
        return response.data || [];
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
            // Fetch trip details from main backend
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

                    // Fetch students at this stop
                    const students = await fetchStudentsAtStop(stop.stop_id);
                    const parentIds = [...new Set(students.map(s => s.parent_id))];

                    if (parentIds.length > 0) {
                        // Fetch parent FCM tokens
                        const tokens = await fetchParentTokens(parentIds);

                        // Send notification
                        await sendFCMNotification(
                            tokens,
                            '🚌 Bus Arrived',
                            `The bus has arrived at ${stop.stop_name}`,
                            {
                                trip_id: trip_id,
                                stop_name: stop.stop_name,
                                stop_id: stop.stop_id,
                                distance: distance.toString()
                            }
                        );
                    }

                    // Notify next stop parents
                    if (i + 1 < tripData.stops.length) {
                        const nextStop = tripData.stops[i + 1];
                        const nextStudents = await fetchStudentsAtStop(nextStop.stop_id);
                        const nextParentIds = [...new Set(nextStudents.map(s => s.parent_id))];

                        if (nextParentIds.length > 0) {
                            const nextTokens = await fetchParentTokens(nextParentIds);
                            await sendFCMNotification(
                                nextTokens,
                                '🚌 Bus Approaching',
                                `The bus has arrived at ${stop.stop_name} and will reach ${nextStop.stop_name} in a few minutes`,
                                {
                                    trip_id: trip_id,
                                    stop_name: nextStop.stop_name,
                                    stop_id: nextStop.stop_id,
                                    previous_stop: stop.stop_name
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
            const students = await fetchStudentsAtStop(stop_id);
            const parentIds = [...new Set(students.map(s => s.parent_id))];
            tokens = await fetchParentTokens(parentIds);
        } else {
            // Send to all parents on the route
            const tripData = activeTrips.get(trip_id);
            if (tripData) {
                for (const stop of tripData.stops) {
                    const students = await fetchStudentsAtStop(stop.stop_id);
                    const parentIds = [...new Set(students.map(s => s.parent_id))];
                    const stopTokens = await fetchParentTokens(parentIds);
                    tokens.push(...stopTokens);
                }
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
// Health Check Endpoint
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        active_trips: activeTrips.size,
        timestamp: new Date().toISOString()
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Bus Tracking Service running on port ${PORT}`);
    console.log(`📡 Main Backend: ${MAIN_BACKEND_URL}`);
    console.log(`📍 Geofence Radius: ${GEOFENCE_RADIUS}m`);
});
