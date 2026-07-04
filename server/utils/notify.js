const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../../data');
const settingsPath = path.join(dataDir, 'settings.json');

function notify(message) {
    try {
        if (!fs.existsSync(settingsPath)) return;
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const webhookUrl = settings.WebhookUrl;

        if (!webhookUrl) return; // No webhook configured

        // Build target URL exactly as configured by the user
        const targetUrl = webhookUrl.trim();

        const postData = JSON.stringify({ message });

        const parsedUrl = new URL(targetUrl);
        const requestModule = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = requestModule.request(options, (res) => {
            // we don't necessarily care about the response
            res.on('data', () => { });
        });

        req.on('error', (e) => {
            console.error(`[Notify] Webhook 推送失败: ${e.message}`);
        });

        req.write(postData);
        req.end();
    } catch (e) {
        console.error(`[Notify] Webhook 发送异常: ${e.message}`);
    }
}

module.exports = { notify };
