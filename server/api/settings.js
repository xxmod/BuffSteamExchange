const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const envPath = path.join(__dirname, '../../.env');
const dataDir = path.join(__dirname, '../../data');

router.get('/', (req, res) => {
    let envData = {};
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        lines.forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                envData[match[1].trim()] = match[2].trim();
            }
        });
    }
    
    let settings = {};
    const settingsPath = path.join(dataDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch (e) {}
    }

    res.json({ env: envData, settings });
});

router.post('/', (req, res) => {
    console.log(`[Settings API] 收到保存核心环境变量与系统配置请求`);
    const { env, settings } = req.body;
    
    if (env) {
        let envString = '';
        for (const [key, value] of Object.entries(env)) {
            envString += `${key}=${value}\n`;
        }
        fs.writeFileSync(envPath, envString, 'utf8');
    }

    if (settings) {
        fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
    }

    res.json({ success: true });
});

router.get('/export', (req, res) => {
    console.log(`[Settings API] 收到导出系统全量备份数据请求`);
    // Export all data files and env into one json
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
    const exportData = {
        _meta: { type: "BuffSteamExchange_Backup", date: new Date().toISOString() },
        dataFiles: {},
        env: ""
    };

    files.forEach(file => {
        try {
            exportData.dataFiles[file] = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
        } catch (e) {
            console.error(`Error reading ${file} for export:`, e);
        }
    });

    if (fs.existsSync(envPath)) {
        exportData.env = fs.readFileSync(envPath, 'utf8');
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=backup.json');
    res.send(JSON.stringify(exportData, null, 2));
});

router.post('/import', express.json({limit: '50mb'}), (req, res) => {
    console.log(`[Settings API] 收到导入系统全量备份数据请求`);
    const { dataFiles, env, _meta } = req.body;
    if (!_meta || _meta.type !== "BuffSteamExchange_Backup") {
        return res.status(400).json({ error: "Invalid backup file." });
    }

    if (env) {
        fs.writeFileSync(envPath, env, 'utf8');
    }

    if (dataFiles) {
        for (const [filename, content] of Object.entries(dataFiles)) {
            fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(content, null, 2), 'utf8');
        }
    }

    res.json({ success: true });
});

module.exports = router;
