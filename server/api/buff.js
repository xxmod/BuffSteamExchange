const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const https = require('https');

const dataDir = path.join(__dirname, '../../data');
const buffPath = path.join(dataDir, 'buff_item.json');
const envPath = path.join(__dirname, '../../.env');

// =======================
// Helper: Load env
// =======================
function getEnvVars() {
    const envVars = {};
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
            if (!line || line.startsWith('#')) return;
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                envVars[match[1].trim()] = match[2].trim();
            }
        });
    }
    return envVars;
}

// =======================
// Refresh logic (getItemInfo & modifiedItemInfo)
// =======================
let isUpdatingBuff = false;
let HttpsProxyAgent;
try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch (e) {}

function fetchJson(url, cookie = '') {
    return new Promise((resolve, reject) => {
        const options = { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0', 'Accept': 'application/json' } };
        if (cookie) options.headers['Cookie'] = cookie;
        
        let proxyUrl = null;
        try {
            const envPath = path.join(__dirname, '../../.env');
            if (fs.existsSync(envPath)) {
                const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
                for (let line of lines) {
                    const match = line.match(/^ProxyUrl=(.*)$/);
                    if (match) {
                        proxyUrl = match[1].trim();
                        break;
                    }
                }
            }
        } catch (e) {}

        if (proxyUrl === null || proxyUrl === undefined) {
            proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
        }
        if (!proxyUrl || proxyUrl.trim() === '') proxyUrl = null;

        if (proxyUrl && HttpsProxyAgent) options.agent = new HttpsProxyAgent(proxyUrl);

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 429) return resolve({ error: '429', message: 'Rate limited' });
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} - ${data.substring(0, 100)}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON Parse failed: ${data.substring(0,100)}`)); }
            });
        }).on('error', reject);
    });
}

async function fetchSteamData(marketHashName) {
    try {
        const { getSteamCommunity } = require('./steam.js');
        const { community } = await getSteamCommunity();
        if (!community) {
            return { volume: '未登录 Steam', price: '未登录 Steam' };
        }
        const url = `https://steamcommunity.com/market/priceoverview/?country=CN&currency=23&appid=730&market_hash_name=${encodeURIComponent(marketHashName)}`;
        
        const data = await new Promise((resolve) => {
            community.httpRequest({ uri: url, json: true }, (err, response, body) => {
                if (err) {
                    if (err.message && err.message.includes('429')) return resolve({ error: '429' });
                    return resolve({ error: err.message });
                }
                if (response && response.statusCode === 429) return resolve({ error: '429' });
                resolve(body);
            });
        });

        if (data && data.error === '429') return { volume: 'Steam API 限制(429)', price: 'Steam API 限制(429)' };
        if (data && data.error) return { volume: `错误: ${data.error}`, price: `错误: ${data.error}` };

        let volume = 0, price = '无数据';
        if (data && data.volume) volume = parseInt(data.volume.replace(/,/g, ''));
        let priceStr = null;
        if (data && data.lowest_price) priceStr = data.lowest_price;
        else if (data && data.median_price) priceStr = data.median_price;
        if (priceStr) {
            const match = priceStr.match(/[\d.]+/);
            if (match) price = parseFloat(match[0]);
        }
        return { volume, price };
    } catch (e) { return { volume: `错误: ${e.message}`, price: `错误: ${e.message}` }; }
}

function isValidNumber(val) {
    if (val === null || val === undefined) return false;
    const strVal = String(val).trim();
    if (strVal === '') return false;
    return !isNaN(Number(strVal));
}

async function updateBuffItemsInBackground() {
    if (isUpdatingBuff) {
        console.log("[Buff API] 警告: 后台刷新任务已经在运行，跳过本次触发");
        return;
    }
    isUpdatingBuff = true;
    console.log("[Buff API] 开始执行后台 Buff 市场数据抓取任务...");
    try {
        const envVars = getEnvVars();
        let cookie = envVars.BuffCookie || '';
        cookie = cookie.split(';').map(c => c.trim()).filter(c => c).join('; ');

        const settingsPath = path.join(dataDir, 'settings.json');
        let buffMaxItems = 1000;
        let buffExcludeKeywords = [];
        if (fs.existsSync(settingsPath)) {
            try {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.BuffMaxItems) buffMaxItems = parseInt(settings.BuffMaxItems) || 1000;
                if (settings.BuffExcludeKeywords) {
                    buffExcludeKeywords = settings.BuffExcludeKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
                }
            } catch(e) {}
        }
        
        let results = [];
        let pageNum = 1;

        console.log(`[Buff API] [执行过程] 正在获取 Buff 市场按销量排序前 ${buffMaxItems} 名商品列表...`);
        while (results.length < buffMaxItems) {
            const url = `https://buff.163.com/api/market/goods?game=csgo&page_num=${pageNum}&sort_by=sell_num.desc`;
            console.log(`[Buff API] [执行过程] 抓取 Buff 第 ${pageNum} 页商品列表...`);
            const data = await fetchJson(url, cookie);
            if (data.code !== 'OK') {
                console.error(`[Buff API] [执行过程] Buff 数据请求异常，提前终止。API响应: ${JSON.stringify(data)}`);
                break;
            }
            const items = data.data.items || [];
            if (items.length === 0) {
                console.log("[Buff API] [执行过程] Buff 已无更多商品，停止翻页。");
                break;
            }

            for (const item of items) {
                if (results.length >= buffMaxItems) break;
                
                const itemNameLower = item.name.toLowerCase();
                if (buffExcludeKeywords.some(k => itemNameLower.includes(k))) {
                    console.log(`[Buff API] [执行过程] 饰品 [${item.name}] 触发排除关键词，跳过抓取并忽略。`);
                    continue;
                }

                const hashName = item.market_hash_name || item.name;
                console.log(`[Buff API] [执行过程] 正在获取饰品 [${item.name}] (ID: ${item.id}) 的 Steam 平台价格与销量... (${results.length + 1}/${buffMaxItems})`);
                const steamData = await fetchSteamData(hashName);
                console.log(`[Buff API] [执行结果] [${item.name}] 获取完毕 -> Steam底价: ${steamData.price}, 销量: ${steamData.volume}`);
                
                results.push({
                    id: item.id,
                    name: item.name,
                    sell_min_price: item.sell_min_price,
                    sell_num: item.sell_num,
                    steam_min_price: steamData.price,
                    volume_24h: steamData.volume
                });

                if (steamData.volume === 'Steam API 限制(429)' || (typeof steamData.volume === 'string' && steamData.volume.includes('429'))) {
                    console.log(`[Buff API] [执行过程] 遇到 Steam 429 限制，触发风控保护，等待 5 分钟后再继续...`);
                    await delay(300000); // 5 分钟
                } else if (results.length % 30 === 0) {
                    console.log(`[Buff API] [执行过程] 已连续查询 30 次，触发常规防封，等待 2 分钟后再继续...`);
                    await delay(120000); // 2 分钟
                } else {
                    await delay(4000); // 默认 4 秒
                }
            }
            pageNum++;
        }

        console.log(`[Buff API] [执行过程] 成功抓取到 ${results.length} 条基础数据，开始执行过滤逻辑...`);
        const filteredItems = [];
        for (const item of results) {
            const { volume_24h, steam_min_price, sell_num, sell_min_price } = item;
            if (isValidNumber(volume_24h) && isValidNumber(steam_min_price) && isValidNumber(sell_num) && isValidNumber(sell_min_price) && parseFloat(sell_min_price) >= 0.2) {
                const buffPrice = parseFloat(sell_min_price);
                const steamPrice = parseFloat(steam_min_price);
                if (steamPrice > 0) {
                    item.discount_rate = Number((buffPrice / (0.85 * steamPrice)).toFixed(4));
                    filteredItems.push(item);
                }
            }
        }

        console.log(`[Buff API] [执行结果] 过滤逻辑执行完毕。剩余可用饰品 ${filteredItems.length} 件。正在写入本地存储...`);
        fs.writeFileSync(buffPath, JSON.stringify([{ _updatedt: new Date().toISOString() }, ...filteredItems], null, 2));
        console.log(`[Buff API] [执行结果] 任务圆满完成。本次更新已保存至 ${buffPath}`);
    } catch (e) {
        console.error(`[Buff API] [执行结果] 后台更新任务遭遇崩溃失败: ${e.message}`);
    } finally {
        isUpdatingBuff = false;
    }
}

async function updateBuffItems() {
    if (isUpdatingBuff) return { success: true, message: "更新已在后台运行中，请不要重复提交。" };
    updateBuffItemsInBackground();
    return { success: true, message: "已触发后台更新，由于需要逐个查询Steam接口，预计耗时数十分钟，请稍后再来查看。" };
}

// =======================
// Buy logic (buyBuff.js)
// =======================
const requestBuff = (url, method, data, headers) => {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqHeaders = Object.assign({}, headers);
        if (method.toUpperCase() === 'GET') {
            delete reqHeaders['Content-Type'];
        } else if (data) {
            reqHeaders['Content-Length'] = Buffer.byteLength(JSON.stringify(data));
        }
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: reqHeaders
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(body);
                }
            });
        });
        req.on('error', reject);
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function executeBuy(itemId, number, payment, itemInfo) {
    console.log(`[Buff API] 开始执行批量购买任务: 饰品ID [${itemId}], 目标数量 [${number}], 支付方式代码 [${payment}]`);
    const envVars = getEnvVars();
    let buffCookie = envVars.BuffCookie || '';
    buffCookie = buffCookie.split(';').map(c => c.trim()).filter(c => c).join('; ');
    if (!buffCookie) throw new Error("Missing BuffCookie in .env");

    let csrfToken = '';
    const csrfMatch = buffCookie.match(/csrf_token=([^;]+)/);
    if (csrfMatch) csrfToken = csrfMatch[1].replace(/^"|"$/g, '');

    const headers = {
        "Host": "buff.163.com",
        "Origin": "https://buff.163.com",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "X-Csrftoken": csrfToken,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
        "Cookie": buffCookie,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": `https://buff.163.com/goods/${itemId}?from=market`
    };

    const paymentMap = { 1: 3, 2: 6, 3: 51 };
    const payMethodId = paymentMap[payment] || 3;

    const sellOrderUrl = `https://buff.163.com/api/market/goods/sell_order?game=csgo&goods_id=${itemId}&page_num=1&sort_by=default&allow_tradable_cooldown=1&_=${Date.now()}`;
    console.log(`[Buff API] [执行过程] 正在查询饰品 [${itemId}] 当前市场的在售挂单...`);
    const sellRes = await requestBuff(sellOrderUrl, 'GET', null, headers);
    if (sellRes.code !== 'OK') {
        console.error(`[Buff API] [执行结果] 获取卖家列表失败: ${sellRes.error || sellRes.msg}`);
        throw new Error(`获取卖家列表失败: ${sellRes.error || sellRes.msg}`);
    }
    
    let items = sellRes.data.items || [];
    if (items.length === 0) {
        console.warn(`[Buff API] [执行结果] 当前无人在售该物品: ${itemId}`);
        throw new Error("当前无人在售该物品");
    }

    console.log(`[Buff API] [执行过程] 饰品 [${itemId}] 查询成功，当前可用挂单数: ${items.length}，准备执行购买循环...`);

    let bought = 0;
    let results = [];

    for (let i = 0; i < items.length; i++) {
        if (bought >= number) break;
        let item = items[i];
        
        console.log(`[Buff API] [执行过程] [${bought+1}/${number}] 正在尝试买入单号: ${item.id}, 价格: ${item.price}`);
        const payload = {
            game: "csgo",
            goods_id: String(itemId),
            sell_order_id: item.id,
            price: item.price,
            pay_method: payMethodId,
            allow_tradable_cooldown: 0,
            token: "",
            cdkey_id: "",
            hide_non_epay: true
        };
        if (payMethodId === 51) payload.steamid = null;

        const buyUrl = "https://buff.163.com/api/market/goods/buy";
        const buyRes = await requestBuff(buyUrl, 'POST', payload, headers);
        
        if (buyRes.code === 'OK') {
            const orderId = buyRes.data.id;
            bought++;
            console.log(`[Buff API] [执行结果] [${bought}/${number}] 下单成功! 订单号: ${orderId}`);
            
            let payUrl = null;
            if (payment === 2) {
                console.log(`[Buff API] [执行过程] 正在为订单 ${orderId} 获取微信支付链接...`);
                const wxUrl = `https://buff.163.com/api/market/bill_order/wx_pay_qrcode?bill_order_id=${orderId}&_=${Date.now()}`;
                const wxRes = await requestBuff(wxUrl, 'GET', null, headers);
                if (wxRes.code === 'OK') {
                    payUrl = wxRes.data.url || (wxRes.data.elements_v2 && wxRes.data.elements_v2.wechatpay ? wxRes.data.elements_v2.wechatpay.url : null);
                    console.log(`[Buff API] [执行结果] 微信支付链接获取成功。`);
                }
            } else if (payment === 3) {
                console.log(`[Buff API] [执行过程] 正在为订单 ${orderId} 获取支付宝支付链接...`);
                const aliUrl = `https://buff.163.com/api/market/bill_order/page_pay?bill_order_id=${orderId}&_=${Date.now()}`;
                const aliRes = await requestBuff(aliUrl, 'GET', null, headers);
                if (aliRes.code === 'OK') {
                    if (aliRes.data.elements_v2 && aliRes.data.elements_v2.alipay) payUrl = aliRes.data.elements_v2.alipay.url;
                    else if (aliRes.data.elements) payUrl = aliRes.data.elements.url;
                    else payUrl = aliRes.data.url;
                    console.log(`[Buff API] [执行结果] 支付宝支付链接获取成功。`);
                }
            }

            results.push({ orderId, payUrl, status: 'success', price: item.price });

            // Record to in_inventory_item.json
            console.log(`[Buff API] [执行过程] 正在将订单 ${orderId} 写入本地资产追踪文件...`);
            const inInvPath = path.join(dataDir, 'in_inventory_item.json');
            let invItems = [];
            if (fs.existsSync(inInvPath)) {
                try { invItems = JSON.parse(fs.readFileSync(inInvPath, 'utf8')).filter(i => !i._updatedt); } catch (e) {}
            }
            invItems.push({
                goods_id: String(itemId),
                name: itemInfo ? itemInfo.name : 'Unknown Item',
                buff_price: parseFloat(item.price),
                steam_price: itemInfo ? itemInfo.steam_min_price : null,
                status: '待收货',
                assetid: null,
                tradeUnlockTime: null,
                purchasedAt: new Date().toISOString()
            });
            fs.writeFileSync(inInvPath, JSON.stringify([{ _updatedt: new Date().toISOString() }, ...invItems], null, 2), 'utf8');
            console.log(`[Buff API] [执行结果] 资产追踪文件更新完毕。`);

        } else {
            console.error(`[Buff API] [执行结果] 下单失败: ${buyRes.error || buyRes.msg}`);
            results.push({ status: 'failed', error: buyRes.error || buyRes.msg });
            if (buyRes.code === 'COOLING_DOWN') {
                console.error(`[Buff API] [执行结果] 触发冷却限制，停止尝试购买当前饰品。`);
                break;
            }
        }

        if (bought < number) {
            console.log(`[Buff API] [执行过程] 缓冲 1000ms 后进行下一次尝试...`);
            await delay(1000);
        }
    }
    
    console.log(`[Buff API] [执行总结] 饰品 [${itemId}] 批量购买结束。目标: ${number}，成功: ${bought}`);
    return { success: true, bought, target: number, results };
}

// =======================
// Routes
// =======================
router.get('/items', (req, res) => {
    if (fs.existsSync(buffPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(buffPath, 'utf8')).filter(i => !i._updatedt);
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: "Failed to parse buff_item.json" });
        }
    } else {
        res.json([]);
    }
});

router.post('/refresh', async (req, res) => {
    console.log(`[Buff API] 收到强制刷新 Buff 市场数据请求，即将准备进入后台爬取...`);
    try {
        const result = await updateBuffItems();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/buy', async (req, res) => {
    const { items, payment } = req.body; // items: [{ id, number, name, steam_min_price }]
    console.log(`[Buff API] 收到前端发起的购买请求，共计选中 ${items ? items.length : 0} 种饰品类别`);
    if (!items || !payment) return res.status(400).json({ error: "Invalid parameters" });

    try {
        const results = [];
        for (const item of items) {
            const result = await executeBuy(item.id, item.number, payment, item);
            results.push({ item, result });
        }
        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
