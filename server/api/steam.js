const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

const dataDir = path.join(__dirname, '../../data');
const envPath = path.join(__dirname, '../../.env');
const sessionFilePath = path.join(dataDir, 'steam_session.json');

// Helper: load env
function getEnvVars() {
    const envVars = {};
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
            if (!line || line.startsWith('#')) return;
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) envVars[match[1].trim()] = match[2].trim();
        });
    }
    return envVars;
}

function decodeBase64(str) {
    if (!str) return '';
    return Buffer.from(str, 'base64').toString('utf8');
}

// Helper: get authenticated community
async function getSteamCommunity() {
    const envVars = getEnvVars();
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    const sessionOpts = {};
    if (proxyUrl) sessionOpts.httpProxy = proxyUrl;
    
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser, sessionOpts);
    let savedToken = null;
    if (fs.existsSync(sessionFilePath)) {
        try { savedToken = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8')).refreshToken; } catch(e) {}
    }

    if (!savedToken) throw new Error("尚未登录 Steam 或缺少 steam_session.json");
    
    session.refreshToken = savedToken;
    const cookies = await session.getWebCookies();
    
    const request = require('request');
    const communityOpts = { language: 'schinese' };
    if (proxyUrl) communityOpts.request = request.defaults({ proxy: proxyUrl });
    
    const community = new SteamCommunity(communityOpts);
    community.setCookies(cookies);
    return { community, session, envVars };
}

router.get('/inventory', (req, res) => {
    const p = path.join(dataDir, 'inventory.json');
    if (fs.existsSync(p)) res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    else res.json([]);
});

router.get('/owned', (req, res) => {
    const p = path.join(dataDir, 'in_inventory_item.json');
    if (fs.existsSync(p)) res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    else res.json([]);
});

router.post('/owned/delete', (req, res) => {
    const { goods_id, assetid } = req.body;
    const p = path.join(dataDir, 'in_inventory_item.json');
    if (fs.existsSync(p)) {
        let items = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Find and change status to user-used
        items = items.map(i => {
            if (i.goods_id === goods_id && i.assetid === assetid) {
                i.status = '用户自用';
            }
            return i;
        });
        fs.writeFileSync(p, JSON.stringify(items, null, 2), 'utf8');
    }
    res.json({ success: true });
});

router.get('/history', (req, res) => {
    const p = path.join(dataDir, 'sell_history.json');
    if (fs.existsSync(p)) res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
    else res.json([]);
});

router.get('/account', async (req, res) => {
    try {
        const envVars = getEnvVars();
        const accountName = decodeBase64(envVars.SteamAccount);
        const sharedSecret = envVars.SharedSecret;
        let authCode = "N/A";
        if (sharedSecret) {
            authCode = SteamTotp.generateAuthCode(sharedSecret);
        }
        res.json({ success: true, accountName, authCode });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/confirmations', async (req, res) => {
    try {
        const { community, envVars } = await getSteamCommunity();
        const identitySecret = envVars.IdentitySecret;
        const time = Math.floor(Date.now() / 1000);
        const confKey = SteamTotp.getConfirmationKey(identitySecret, time, 'conf');
        const allowKey = SteamTotp.getConfirmationKey(identitySecret, time, 'allow');
        
        community.getConfirmations(time, confKey, (err, confirmations) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, confirmations });
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/confirm', async (req, res) => {
    console.log(`[Steam API] 收到一键同意所有待确认交易/上架请求`);
    const { confId, confKey } = req.body;
    // For simplicity, we can accept all or accept specific
    try {
        const { community, envVars } = await getSteamCommunity();
        const identitySecret = envVars.IdentitySecret;
        const time = Math.floor(Date.now() / 1000);
        const cKey = SteamTotp.getConfirmationKey(identitySecret, time, 'conf');
        const aKey = SteamTotp.getConfirmationKey(identitySecret, time, 'allow');
        
        community.acceptAllConfirmations(time, cKey, aKey, (err, confirmations) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: `已确认 ${confirmations.length} 个请求` });
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/sell', async (req, res) => {
    const { items } = req.body; // array of { assetid, priceWithoutFee }
    console.log(`[Steam API] 收到批量挂单上架请求，共计处理 ${items ? items.length : 0} 件物品`);
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: "Invalid items array" });

    try {
        const { community } = await getSteamCommunity();
        const results = [];
        
        let successCount = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const { assetid, priceWithoutFee } = item;
            const priceWithFee = priceWithoutFee + Math.max(1, Math.floor(priceWithoutFee * 0.05)) + Math.max(1, Math.floor(priceWithoutFee * 0.10));
            console.log(`[Steam API] [执行过程] [${i+1}/${items.length}] 正在尝试上架物品 assetid: ${assetid}，税前单价: ${priceWithoutFee / 100}`);
            
            const sellRes = await new Promise((resolve) => {
                community.httpRequestPost({
                    url: 'https://steamcommunity.com/market/sellitem/',
                    form: {
                        sessionid: community.getSessionID(),
                        appid: 730,
                        contextid: 2,
                        assetid: assetid,
                        amount: 1,
                        price: priceWithoutFee
                    },
                    headers: { 'Referer': 'https://steamcommunity.com/my/inventory/' }
                }, (err, response, body) => {
                    if (err) return resolve({ success: false, error: err.message });
                    try {
                        const data = JSON.parse(body);
                        if (data.success) resolve({ success: true });
                        else resolve({ success: false, error: data.message || "Unknown error" });
                    } catch(e) { resolve({ success: false, error: "Invalid JSON response" }); }
                });
            });

            results.push({ assetid, priceWithoutFee, priceWithFee, ...sellRes });

            if (sellRes.success) {
                console.log(`[Steam API] [执行结果] [${i+1}/${items.length}] 上架成功！`);
                successCount++;
                // Update in_inventory_item.json status to 已挂单
                const inInvPath = path.join(dataDir, 'in_inventory_item.json');
                if (fs.existsSync(inInvPath)) {
                    let inInvItems = JSON.parse(fs.readFileSync(inInvPath, 'utf8'));
                    let modified = false;
                    inInvItems = inInvItems.map(i => {
                        if (i.assetid === assetid && i.status === '待出售') {
                            i.status = '已挂单';
                            i.sell_price_no_fee = priceWithoutFee;
                            i.sell_price_with_fee = priceWithFee;
                            modified = true;
                        }
                        return i;
                    });
                    if (modified) fs.writeFileSync(inInvPath, JSON.stringify(inInvItems, null, 2), 'utf8');
                }
            } else {
                console.error(`[Steam API] [执行结果] [${i+1}/${items.length}] 上架失败: ${sellRes.error}`);
            }
        }
        
        console.log(`[Steam API] [执行总结] 挂单上架任务结束。请求数量: ${items.length}，成功上架: ${successCount}`);
        res.json({ success: true, results });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/inventory/refresh', async (req, res) => {
    console.log(`[Steam API] 收到刷新 Steam 账号库存请求`);
    try {
        const { community, session } = await getSteamCommunity();
        const steamId64 = typeof session.steamID.getSteamID64 === 'function' ? session.steamID.getSteamID64() : session.steamID.toString();
        
        community.getUserInventoryContents(steamId64, 730, 2, false, (err, inventory) => {
            if (err) {
                console.error(`[Steam API] [执行结果] 获取库存失败: ${err.message}`);
                return res.status(500).json({ error: "获取库存失败: " + err.message });
            }
            console.log(`[Steam API] [执行结果] 成功拉取底层库存，共计 ${inventory.length} 件物品，开始解析...`);
            
            const parsedItems = inventory.map(item => {
                let tradeUnlockTime = null;
                if (item.cache_expiration) {
                    try { tradeUnlockTime = new Date(item.cache_expiration).toISOString(); } 
                    catch (e) { tradeUnlockTime = item.cache_expiration; }
                }
                let wear = null;
                if (item.tags && Array.isArray(item.tags)) {
                    const exteriorTag = item.tags.find(t => t.category === 'Exterior');
                    if (exteriorTag) wear = exteriorTag.localized_tag_name || exteriorTag.name;
                }
                return {
                    id: item.id,
                    name: item.market_name || item.name,
                    tradable: item.tradable,
                    tradeUnlockTime,
                    wear
                };
            });
            
            const invPath = path.join(dataDir, 'inventory.json');
            fs.writeFileSync(invPath, JSON.stringify(parsedItems, null, 2), 'utf8');
            console.log(`[Steam API] [执行过程] 最新库存数据已写入至 ${invPath}`);

            // Cross-check with in_inventory_item.json
            const inInvPath = path.join(dataDir, 'in_inventory_item.json');
            if (fs.existsSync(inInvPath)) {
                console.log(`[Steam API] [执行过程] 正在比对 in_inventory_item.json 中的 "待收货" 物品与最新库存...`);
                let inInvItems = [];
                try { inInvItems = JSON.parse(fs.readFileSync(inInvPath, 'utf8')); } catch(e){}
                
                let updatedCount = 0;
                const availableSteamItems = [...parsedItems];

                inInvItems = inInvItems.map(inItem => {
                    if (inItem.status === '待收货') {
                        const matchIndex = availableSteamItems.findIndex(s => s.name === inItem.name);
                        if (matchIndex !== -1) {
                            const matchedSteam = availableSteamItems.splice(matchIndex, 1)[0];
                            inItem.status = '待出售';
                            inItem.assetid = matchedSteam.id;
                            inItem.tradeUnlockTime = matchedSteam.tradeUnlockTime;
                            updatedCount++;
                            console.log(`[Steam API] [执行过程] 匹配成功！将饰品 [${inItem.name}] 与底层 assetid [${matchedSteam.id}] 绑定，状态更新为 "待出售"`);
                        }
                    }
                    return inItem;
                });

                if (updatedCount > 0) {
                    fs.writeFileSync(inInvPath, JSON.stringify(inInvItems, null, 2), 'utf8');
                    console.log(`[Steam API] [执行过程] 共匹配到了 ${updatedCount} 件入库饰品，资产追踪表已保存。`);
                } else {
                    console.log(`[Steam API] [执行过程] 未发现任何新增匹配的待收货物品。`);
                }
            }

            console.log(`[Steam API] [执行总结] 刷新库存任务完毕，返回最新总数: ${parsedItems.length}`);
            res.json({ success: true, count: parsedItems.length, message: "库存刷新成功" });
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
