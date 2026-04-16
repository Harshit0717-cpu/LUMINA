const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Ensure index.html is in the 'public' folder

// MySQL Connection Pool
// MySQL Connection Pool (Cloud Ready)
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    // Required by many cloud providers (like Aiven) to establish a secure connection
    ssl: { rejectUnauthorized: false } 
});

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,       // Add this to your .env
    key_secret: process.env.RAZORPAY_KEY_SECRET // Add this to your .env
});

// ================== ROUTES ==================

// 1. Get Movies
app.get('/api/movies', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT title, rating, description as genre, image_url as img FROM Movie'
        );
        res.json(rows);
    } catch (error) {
        console.error('Error fetching movies:', error);
        res.status(500).json({ error: 'Failed to fetch movies' });
    }
});

// 2. Get Transactions (Filtered by user)
app.get('/api/transactions', async (req, res) => {
    try {
        const { username } = req.query;
        
        let query = `
            SELECT c.name as customer, m.title as movie, 
                   r.rental_date as date, r.rate as amount, r.status, r.utr_number
            FROM Rental r
            JOIN Customer c ON r.cust_id = c.cust_id
            JOIN Tape t ON r.tape_id = t.tape_id
            JOIN Movie m ON t.movie_id = m.movie_id
        `;
        
        const params = [];
        
        if (username) {
            query += ` WHERE c.name = ?`;
            params.push(username);
        }
        
        query += ` ORDER BY r.rental_date DESC`;

        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// 3. Create a Real Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount } = req.body;
        
        // Amount is passed in INR, Razorpay expects paise (multiply by 100)
        const options = {
            amount: amount * 100, 
            currency: "INR",
            receipt: `receipt_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);
        res.json(order);
    } catch (error) {
        console.error('Order creation error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// 4. Verify Payment Signature & Save to Database (PAID)
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { 
            razorpay_order_id, 
            razorpay_payment_id, 
            razorpay_signature,
            username,
            movie,
            amount 
        } = req.body;

        // Verify the cryptographic signature
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: 'Invalid payment signature!' });
        }

        // Get or create customer
        let [customer] = await pool.query('SELECT cust_id FROM Customer WHERE name = ?', [username]);
        let cust_id;
        if (customer.length === 0) {
            const [result] = await pool.query('INSERT INTO Customer (name) VALUES (?)', [username]);
            cust_id = result.insertId;
        } else {
            cust_id = customer[0].cust_id;
        }

        // Get movie_id
        const [movieRow] = await pool.query('SELECT movie_id FROM Movie WHERE title = ?', [movie]);
        if (movieRow.length === 0) return res.status(400).json({ error: 'Movie not found' });
        const movie_id = movieRow[0].movie_id;

        // Get an available tape
        const [tapeRow] = await pool.query('SELECT tape_id FROM Tape WHERE movie_id = ? LIMIT 1', [movie_id]);
        if (tapeRow.length === 0) return res.status(400).json({ error: 'No tapes available' });
        const tape_id = tapeRow[0].tape_id;

        // Insert into Rental (Saving Razorpay Payment ID as the UTR)
        await pool.query(
            `INSERT INTO Rental (cust_id, tape_id, rental_date, rate, status, utr_number)
             VALUES (?, ?, NOW(), ?, 'Paid', ?)`,
            [cust_id, tape_id, amount, razorpay_payment_id]
        );

        res.json({ message: 'Payment verified and stored successfully!' });

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

// 5. Log Cancelled or Rejected Transactions (REJECTED)
app.post('/api/cancel-payment', async (req, res) => {
    try {
        const { username, movie, amount } = req.body;

        // Get or create customer
        let [customer] = await pool.query('SELECT cust_id FROM Customer WHERE name = ?', [username]);
        let cust_id;
        if (customer.length === 0) {
            const [result] = await pool.query('INSERT INTO Customer (name) VALUES (?)', [username]);
            cust_id = result.insertId;
        } else {
            cust_id = customer[0].cust_id;
        }

        // Get movie_id
        const [movieRow] = await pool.query('SELECT movie_id FROM Movie WHERE title = ?', [movie]);
        if (movieRow.length === 0) return res.status(400).json({ error: 'Movie not found' });
        const movie_id = movieRow[0].movie_id;

        // Get an available tape
        const [tapeRow] = await pool.query('SELECT tape_id FROM Tape WHERE movie_id = ? LIMIT 1', [movie_id]);
        if (tapeRow.length === 0) return res.status(400).json({ error: 'No tapes available' });
        const tape_id = tapeRow[0].tape_id;

        // Insert into Rental with 'Rejected' status and NO UTR
        await pool.query(
            `INSERT INTO Rental (cust_id, tape_id, rental_date, rate, status, utr_number)
             VALUES (?, ?, NOW(), ?, 'Rejected', NULL)`,
            [cust_id, tape_id, amount]
        );

        res.json({ message: 'Cancellation logged successfully!' });

    } catch (error) {
        console.error('Cancellation logging error:', error);
        res.status(500).json({ error: 'Failed to log cancellation' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});