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

router.post('/owned/manual-bind', (req, res) => {
    console.log(`[Steam API] 收到手动收货绑定请求`);
    const { goods_id, purchasedAt, assetid } = req.body;
    const p = path.join(dataDir, 'in_inventory_item.json');
    if (fs.existsSync(p)) {
        let items = JSON.parse(fs.readFileSync(p, 'utf8'));
        let found = false;
        items = items.map(i => {
            if (i.goods_id === goods_id && i.purchasedAt === purchasedAt && i.status === '待收货') {
                i.status = '待出售';
                i.assetid = assetid;
                console.log(`[Steam API] [执行结果] 手动绑定成功: ${i.name} -> Asset ID: ${assetid}`);
                found = true;
            }
            return i;
        });
        if (found) {
            fs.writeFileSync(p, JSON.stringify(items, null, 2), 'utf8');
            return res.json({ success: true });
        } else {
            return res.status(404).json({ error: "找不到匹配的待收货物品记录" });
        }
    }
    res.status(404).json({ error: "资产追踪文件不存在" });
});

router.post('/owned/add-manual', (req, res) => {
    console.log(`[Steam API] 收到手动添加饰品请求`);
    const { assetid, buff_price } = req.body;
    
    const invPath = path.join(dataDir, 'inventory.json');
    if (!fs.existsSync(invPath)) {
        return res.status(400).json({ error: "尚未获取 Steam 底层库存，请先刷新库存" });
    }
    const inventory = JSON.parse(fs.readFileSync(invPath, 'utf8'));
    const steamItem = inventory.find(i => i.id === String(assetid));
    if (!steamItem) {
        return res.status(404).json({ error: "在底层库存中未找到指定的 Asset ID，请先刷新底层库存" });
    }

    const p = path.join(dataDir, 'in_inventory_item.json');
    let items = [];
    if (fs.existsSync(p)) {
        items = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    
    // Check if already exists
    if (items.find(i => i.assetid === String(assetid))) {
        return res.status(400).json({ error: "该饰品已经存在于持有列表中" });
    }
    
    // Generate a pseudo goods_id since it's manual
    const fakeGoodsId = 'manual_' + Date.now().toString().slice(-6);

    const newItem = {
        goods_id: fakeGoodsId,
        name: steamItem.name,
        buff_price: parseFloat(buff_price) || 0,
        steam_price: 0,
        status: "待出售",
        assetid: steamItem.id,
        tradeUnlockTime: steamItem.tradeUnlockTime,
        purchasedAt: new Date().toISOString()
    };
    
    items.push(newItem);
    fs.writeFileSync(p, JSON.stringify(items, null, 2), 'utf8');
    console.log(`[Steam API] [执行结果] 手动添加成功: ${newItem.name}`);
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
    const { items } = req.body; // array of { assetid, priceWithoutFee, market_hash_name, auto_price }
    console.log(`[Steam API] 收到批量挂单上架请求，共计处理 ${items ? items.length : 0} 件物品`);
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: "Invalid items array" });

    function calcPriceWithoutFee(targetWithFeeCents) {
        let p = Math.floor(targetWithFeeCents / 1.15);
        while (true) {
            let f1 = Math.max(1, Math.floor(p * 0.05));
            let f2 = Math.max(1, Math.floor(p * 0.10));
            let total = p + f1 + f2;
            if (total === targetWithFeeCents) return p;
            if (total > targetWithFeeCents) return p - 1;
            p++;
        }
    }

    try {
        const { community } = await getSteamCommunity();
        const results = [];
        
        // Load inventory to look up market_hash_name
        let inventory = [];
        const invPath = path.join(dataDir, 'inventory.json');
        if (fs.existsSync(invPath)) {
            try { inventory = JSON.parse(fs.readFileSync(invPath, 'utf8')); } catch(e) {}
        }
        
        let successCount = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            let { assetid, priceWithoutFee, auto_price } = item;
            
            const invItem = inventory.find(inv => inv.id === String(assetid));
            const market_hash_name = invItem ? invItem.market_hash_name : item.market_hash_name;
            
            if (auto_price && market_hash_name) {
                console.log(`[Steam API] [执行过程] [${i+1}/${items.length}] 正在获取 ${market_hash_name} 的实时最低价...`);
                try {
                    const priceData = await new Promise((resolve) => {
                        community.httpRequest({
                            uri: `https://steamcommunity.com/market/priceoverview/?country=CN&currency=23&appid=730&market_hash_name=${encodeURIComponent(market_hash_name)}`,
                            json: true
                        }, (err, response, body) => {
                            if (err) {
                                console.log(`[Steam API] [执行过程] HTTP Error: ${err.message}`);
                                return resolve(null);
                            }
                            if (!body || !body.success) {
                                console.log(`[Steam API] [执行过程] Steam 接口返回失败. Body: ${JSON.stringify(body)}`);
                                return resolve(null);
                            }
                            resolve(body);
                        });
                    });
                    if (priceData) {
                        console.log(`[Steam API] [执行过程] Steam 原始返回数据: ${JSON.stringify(priceData)}`);
                        if (priceData.lowest_price) {
                            let lowestNum = parseFloat(priceData.lowest_price.replace(/[^\d.]/g, ''));
                            if (!isNaN(lowestNum) && lowestNum > 0) {
                                let targetPriceWithFee = Math.round(lowestNum * 100) - 1; // 减 1 分钱
                                if (targetPriceWithFee < 3) targetPriceWithFee = 3;
                                priceWithoutFee = calcPriceWithoutFee(targetPriceWithFee);
                                console.log(`[Steam API] [执行过程] [${i+1}/${items.length}] 获取成功: Steam 底价 ¥${lowestNum}，挂单价 ¥${(targetPriceWithFee/100).toFixed(2)}，到手价 ¥${(priceWithoutFee/100).toFixed(2)}`);
                            } else {
                                throw new Error("价格解析失败");
                            }
                        } else {
                            throw new Error("未能获取到价格数据，可能物品暂无在售或流控。");
                        }
                    } else {
                        throw new Error("价格请求返回为空");
                    }
                } catch (e) {
                    console.log(`[Steam API] [执行过程] [${i+1}/${items.length}] 实时获取价格失败，终止上架: ${e.message}`);
                    results.push({ assetid, success: false, error: "无法获取最新售价: " + e.message });
                    continue;
                }
            }

            if (!priceWithoutFee || priceWithoutFee <= 0) {
                results.push({ assetid, success: false, error: "Invalid price calculation" });
                continue;
            }

            const priceWithFee = priceWithoutFee + Math.max(1, Math.floor(priceWithoutFee * 0.05)) + Math.max(1, Math.floor(priceWithoutFee * 0.10));
            console.log(`[Steam API] [执行过程] [${i+1}/${items.length}] 正在尝试上架物品 assetid: ${assetid}，到手价: ¥${(priceWithoutFee / 100).toFixed(2)}`);
            
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchFullContext(community, steamId, appId, contextId, count = 75, lang = 'schinese') {
    let allAssets = [];
    let descriptionsMap = {};
    let lastAssetId = null;
    let _429_attempts = 0;
    const MAX_429_RETRIES = 3;

    while (true) {
        let uri = `https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}?l=${lang}&count=${count}&preserve_bbcode=1&raw_asset_properties=1`;
        if (lastAssetId) {
            uri += `&start_assetid=${lastAssetId}`;
        }

        const data = await new Promise((resolve, reject) => {
            community.httpRequest({ uri, json: true }, (err, response, body) => {
                if (err) return reject(err);
                if (response.statusCode === 429) return resolve(429);
                if (response.statusCode !== 200) return reject(new Error("HTTP " + response.statusCode));
                resolve(body);
            });
        });

        if (data === 429) {
            _429_attempts++;
            if (_429_attempts > MAX_429_RETRIES) throw new Error("Max 429 retries reached");
            await delay(10000 * Math.pow(2, _429_attempts - 1));
            continue;
        }

        if (!data || data.success !== 1) {
            throw new Error("Invalid response or success != 1");
        }

        const currentAssets = data.assets || [];
        const currentDescs = data.descriptions || [];

        if (currentAssets.length === 0) break;
        
        allAssets = allAssets.concat(currentAssets);
        for (const d of currentDescs) {
            if (d.classid) {
                const iid = d.instanceid || "0";
                descriptionsMap[`${d.classid}_${iid}`] = d;
            }
        }

        const moreItems = data.more_items === 1;
        if (!moreItems) break;

        lastAssetId = data.last_assetid;
        if (!lastAssetId && currentAssets.length > 0) {
            lastAssetId = currentAssets[currentAssets.length - 1].assetid;
        }
        if (!lastAssetId) break;

        await delay(1000); // 1s jittered sleep
    }

    return { assets: allAssets, descriptions: Object.values(descriptionsMap) };
}

async function fetchCS2Inventory(community, steamId) {
    const mainCtx = await fetchFullContext(community, steamId, 730, 2);
    let secCtx;
    try {
        secCtx = await fetchFullContext(community, steamId, 730, 16);
    } catch (e) {
        console.log(`[Steam API] [执行过程] 拉取 context 16 失败或无数据: ${e.message}`);
        secCtx = { assets: [], descriptions: [] };
    }

    const combinedAssets = [...mainCtx.assets, ...secCtx.assets];
    const combinedDescs = [...mainCtx.descriptions, ...secCtx.descriptions];

    const uniqueDescs = {};
    for (const d of combinedDescs) {
        if (d.classid) {
            const iid = d.instanceid || "0";
            uniqueDescs[`${d.classid}_${iid}`] = d;
        }
    }

    return {
        assets: combinedAssets,
        descriptions: Object.values(uniqueDescs)
    };
}

router.post('/inventory/refresh', async (req, res) => {
    console.log(`[Steam API] 收到刷新 Steam 账号库存请求`);
    try {
        const { community, session } = await getSteamCommunity();
        const steamId64 = typeof session.steamID.getSteamID64 === 'function' ? session.steamID.getSteamID64() : session.steamID.toString();
        
        console.log(`[Steam API] [执行过程] 开始通过自定义防封策略拉取底层库存...`);
        let inventoryData;
        try {
            inventoryData = await fetchCS2Inventory(community, steamId64);
        } catch(err) {
            console.error(`[Steam API] [执行结果] 获取库存失败: ${err.message}`);
            return res.status(500).json({ error: "获取库存失败: " + err.message });
        }

        const { assets, descriptions } = inventoryData;
        console.log(`[Steam API] [执行结果] 成功拉取底层库存，共计 ${assets.length} 件物品，开始解析...`);
        
        const parsedItems = assets.map(asset => {
            const desc = descriptions.find(d => String(d.classid) === String(asset.classid) && String(d.instanceid || '0') === String(asset.instanceid || '0')) || {};
            
            let tradeUnlockTime = null;
            if (desc.cache_expiration) {
                try { tradeUnlockTime = new Date(desc.cache_expiration).toISOString(); } 
                catch (e) { tradeUnlockTime = desc.cache_expiration; }
            }
            if (!tradeUnlockTime && desc.owner_descriptions) {
                for (let od of desc.owner_descriptions) {
                    if (od.value && od.value.includes('交易')) {
                        const bbcodeDateMatch = od.value.match(/\[date\](\d+)\[\/date\]/i);
                        if (bbcodeDateMatch) {
                            const unixTime = parseInt(bbcodeDateMatch[1], 10);
                            tradeUnlockTime = new Date(unixTime * 1000).toISOString();
                        } else {
                            // 降级兼容旧版纯文本格式，防患于未然
                            const textMatch = od.value.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[(\uff08]\s*(\d{1,2}:\d{2}:\d{2})(?:\s*GMT)?\s*[)\uff09]/);
                            if (textMatch) {
                                const [_, year, month, day, time] = textMatch;
                                const [h, m, s] = time.split(':');
                                const paddedTime = `${h.padStart(2, '0')}:${m}:${s}`;
                                try {
                                    tradeUnlockTime = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${paddedTime}Z`).toISOString();
                                } catch(e) {}
                            }
                        }
                    }
                }
            }
            
            let wear = null;
            if (desc.tags && Array.isArray(desc.tags)) {
                const exteriorTag = desc.tags.find(t => t.category === 'Exterior');
                if (exteriorTag) wear = exteriorTag.localized_tag_name || exteriorTag.name;
            }
            return {
                id: asset.assetid,
                name: desc.market_name || desc.name || 'Unknown Item',
                market_hash_name: desc.market_hash_name || desc.market_name || desc.name,
                tradable: desc.tradable === 1,
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

            const newInInvItems = [];
            const soldItems = [];

            for (let inItem of inInvItems) {
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
                    newInInvItems.push(inItem);
                } else if (inItem.assetid) {
                    // 已绑定的物品（如 待出售，已挂单），每次刷新库存时更新其最新的解锁时间和相关信息
                    const matchIndex = availableSteamItems.findIndex(s => s.id === inItem.assetid);
                    if (matchIndex !== -1) {
                        const matchedSteam = availableSteamItems[matchIndex];
                        if (inItem.tradeUnlockTime !== matchedSteam.tradeUnlockTime) {
                            inItem.tradeUnlockTime = matchedSteam.tradeUnlockTime;
                            updatedCount++;
                            console.log(`[Steam API] [执行过程] 已更新绑定的饰品 [${inItem.name}] 的解锁时间为 ${matchedSteam.tradeUnlockTime || 'null'}`);
                        }
                        newInInvItems.push(inItem);
                    } else {
                        // 物品不在Steam底层库存中，说明已经不在账号里了
                        if (inItem.status === '已挂单') {
                            console.log(`[Steam API] [执行过程] 饰品 [${inItem.name}] (assetid: ${inItem.assetid}) 已在 Steam 库存中消失，判定为售出。`);
                            soldItems.push({
                                name: inItem.name,
                                buff_price: inItem.buff_price,
                                sell_price_with_fee: inItem.sell_price_with_fee,
                                sell_price_no_fee: inItem.sell_price_no_fee,
                                soldAt: new Date().toLocaleString()
                            });
                            updatedCount++;
                        } else {
                            console.log(`[Steam API] [执行过程] 饰品 [${inItem.name}] (assetid: ${inItem.assetid}) (状态: ${inItem.status}) 已在 Steam 库存中消失，移出追踪。`);
                            updatedCount++;
                        }
                    }
                } else {
                    newInInvItems.push(inItem);
                }
            }

            if (soldItems.length > 0) {
                const historyPath = path.join(dataDir, 'sell_history.json');
                let history = [];
                if (fs.existsSync(historyPath)) {
                    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch(e){}
                }
                history.push(...soldItems);
                fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
                console.log(`[Steam API] [执行过程] 新增 ${soldItems.length} 条出售历史记录。`);
            }

            if (updatedCount > 0) {
                fs.writeFileSync(inInvPath, JSON.stringify(newInInvItems, null, 2), 'utf8');
                console.log(`[Steam API] [执行过程] 共发生 ${updatedCount} 次资产追踪表变动，已保存。`);
            } else {
                console.log(`[Steam API] [执行过程] 未发现任何需要更新的待收货/待出售物品。`);
            }
        }

        console.log(`[Steam API] [执行总结] 刷新库存任务完毕，返回最新总数: ${parsedItems.length}`);
        res.json({ success: true, count: parsedItems.length, message: "库存刷新成功" });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
