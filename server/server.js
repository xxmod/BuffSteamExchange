const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 9998;

// Middleware
app.use(cors());
app.use(express.json());

// Basic Auth Middleware
app.use((req, res, next) => {
    // Exclude preflight requests
    if (req.method === 'OPTIONS') return next();

    let username = 'admin';
    let password = '123456';
    const settingsPath = path.join(__dirname, '../data/settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (settings.AuthUsername) username = settings.AuthUsername;
            if (settings.AuthPassword) password = settings.AuthPassword;
        } catch(e) {}
    }

    let b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    if (!b64auth && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
        if (match) b64auth = match[1];
    }
    
    const [login, pwd] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login && pwd && login === username && pwd === password) {
        if (!req.headers.cookie || !req.headers.cookie.includes(`auth_token=${b64auth}`)) {
            res.cookie('auth_token', b64auth, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
        }
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="BuffSteam Exchange"');
    res.status(401).send('Authentication required.');
});

app.use(express.static(path.join(__dirname, '../public')));

// Request logging middleware
app.use((req, res, next) => {
    if (req.method !== 'OPTIONS' && req.path !== '/api/logs') {
        console.log(`[API Request] ${req.method} ${req.path}`);
    }
    next();
});

// Ensure data dir exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Ensure necessary data files exist
const defaultFiles = ['in_inventory_item.json', 'sell_history.json', 'settings.json'];
defaultFiles.forEach(file => {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '[]', 'utf8');
        if (file === 'settings.json') fs.writeFileSync(filePath, '{}', 'utf8');
    }
});

const logFile = path.join(dataDir, 'logs.txt');
if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '', 'utf8');

const originalLog = console.log;
const originalError = console.error;

function formatLogMsg(args) {
    return args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
}

function writeLog(level, ...args) {
    const msg = `[${new Date().toISOString()}] [${level}] ${formatLogMsg(args)}\n`;
    fs.appendFileSync(logFile, msg, 'utf8');
}

console.log = function(...args) {
    originalLog.apply(console, args);
    writeLog('INFO', ...args);
};

console.error = function(...args) {
    originalError.apply(console, args);
    writeLog('ERROR', ...args);
};

app.get('/api/logs', (req, res) => {
    if (fs.existsSync(logFile)) {
        // Return last 200 lines to avoid massive payloads
        const content = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
        res.json({ logs: content.slice(-200) });
    } else {
        res.json({ logs: ["No logs available."] });
    }
});

// Import API routes 
const buffRoutes = require('./api/buff');
const steamRoutes = require('./api/steam');
const settingsRoutes = require('./api/settings');

app.use('/api/buff', buffRoutes);
app.use('/api/steam', steamRoutes);
app.use('/api/settings', settingsRoutes);

// Start scheduler
require('./scheduler');

app.listen(PORT, () => {
    console.log(`Web UI server listening on http://localhost:${PORT}`);
});
