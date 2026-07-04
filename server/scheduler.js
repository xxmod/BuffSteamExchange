const fs = require('fs');
const path = require('path');
// const { updateBuffItems } = require('./api/buff'); // Later
// const { updateSteamInventory } = require('./api/steam'); // Later
const steamRouter = require('./api/steam');

const dataDir = path.join(__dirname, '../data');

const delay = ms => new Promise(res => setTimeout(res, ms));

function calculateSlope(prices) {
    if (!prices || prices.length < 2) return 0;
    prices.sort((a, b) => new Date(a[0].substring(0, 11)) - new Date(b[0].substring(0, 11)));
    const recentPrices = prices.slice(-30);
    const n = recentPrices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        const x = i;
        const y = recentPrices[i][1];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
    }
    const denominator = (n * sumX2 - sumX * sumX);
    if (denominator === 0) return 0;
    return (n * sumXY - sumX * sumY) / denominator;
}

function checkAndRunScheduler() {
    console.log("[Scheduler] Scheduled check running...");
    
    // Check Buff items modified time
    const buffPath = path.join(dataDir, 'buff_item.json');
    if (fs.existsSync(buffPath)) {
        const stats = fs.statSync(buffPath);
        const daysOld = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
        if (daysOld > 3) {
            console.log("[Scheduler] buff_item.json is older than 3 days. Triggering update...");
            // updateBuffItems().catch(console.error);
        }
    }

    // Check inventory
    const invPath = path.join(dataDir, 'inventory.json');
    if (fs.existsSync(invPath)) {
        const stats = fs.statSync(invPath);
        const daysOld = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
        // Check if there are pending items
        const inInvPath = path.join(dataDir, 'in_inventory_item.json');
        let hasPending = false;
        if (fs.existsSync(inInvPath)) {
            try {
                const items = JSON.parse(fs.readFileSync(inInvPath, 'utf8')).filter(i => !i._updatedt);
                hasPending = items.some(i => i.status === '待收货');
            } catch (e) {}
        }

        if (daysOld > 2 && !hasPending) {
            console.log("[Scheduler] inventory.json is older than 2 days and no pending items. Triggering update...");
            // updateSteamInventory().catch(console.error);
        }
    }

    // 1-hour inventory check for pending receives
    // We will implement this later when steam.js is ready
}

const http = require('http');

async function checkAutoSellTradableItems() {
    try {
        const settingsPath = path.join(dataDir, 'settings.json');
        let settings = {};
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }

        if (!settings.autoSellTradable) {
            return;
        }

        const inInvPath = path.join(dataDir, 'in_inventory_item.json');
        if (!fs.existsSync(inInvPath)) return;
        
        let items = [];
        try { items = JSON.parse(fs.readFileSync(inInvPath, 'utf8')).filter(i => !i._updatedt); } catch(e) {}
        
        const now = new Date();
        const itemsToSell = [];
        let modifiedInInv = false;
        
        // Cache for trend fitting results during this sale run
        const trendCache = {};

        for (const item of items) {
            if (item.status === '待出售' && item.tradeUnlockTime) {
                const unlockTime = new Date(item.tradeUnlockTime);
                if (unlockTime <= now) {
                    const itemName = item.market_hash_name || item.name;
                    item.hold_cycle = item.hold_cycle || 0;
                    
                    let slope = trendCache[itemName];
                    let fetchedNow = false;

                    if (slope === undefined) {
                        console.log(`[Scheduler] Fetching price history for ${itemName} to calculate trend...`);
                        const history = await steamRouter.getPriceHistory(itemName);
                        if (history) {
                            slope = calculateSlope(history);
                            trendCache[itemName] = slope;
                            fetchedNow = true;
                        }
                    }

                    if (slope !== undefined && slope > 0) {
                        if (item.hold_cycle < 3) {
                            item.hold_cycle += 1;
                            modifiedInInv = true;
                            console.log(`[Scheduler] ${itemName} shows UPWARD trend (slope ${slope.toFixed(4)}), holding for another cycle (${item.hold_cycle}/3).`);
                            try {
                                const { notify } = require('./utils/notify');
                                notify(`[预测持有] 饰品 [${itemName}] 预测价格上涨，当前第 ${item.hold_cycle} 个等待周期，暂不出售。`);
                            } catch(e) {}
                            
                            if (fetchedNow) await delay(60000); // 1 minute delay to prevent 429
                            continue; // Skip selling this item
                        } else {
                            console.log(`[Scheduler] ${itemName} shows UPWARD trend but reached max hold cycles (3). Proceeding to sell.`);
                            try {
                                const { notify } = require('./utils/notify');
                                notify(`[强制出售] 饰品 [${itemName}] 虽预测价格上涨，但已达最大等待周期(3次)，立即上架。`);
                            } catch(e) {}
                        }
                    } else if (slope !== undefined && slope <= 0) {
                        console.log(`[Scheduler] ${itemName} shows DOWNWARD or FLAT trend (slope ${slope.toFixed(4)}). Proceeding to sell.`);
                        try {
                            const { notify } = require('./utils/notify');
                            notify(`[策略出售] 饰品 [${itemName}] 预测价格下跌或走势不佳，不再等待，立即上架。`);
                        } catch(e) {}
                    } else {
                        // slope is undefined (failed to fetch history), proceed to sell normally without strategy
                        try {
                            const { notify } = require('./utils/notify');
                            notify(`[解锁] 饰品 [${itemName}] (成本: ¥${item.buff_price}) 已过交易锁定期，准备执行自动上架策略。`);
                        } catch(e) {}
                    }

                    itemsToSell.push({
                        assetid: item.assetid,
                        auto_price: true,
                        market_hash_name: itemName,
                        auto_sell_mode: true,
                        buff_price: item.buff_price || 0
                    });

                    if (fetchedNow) await delay(60000); // 1 minute delay to prevent 429
                }
            }
        }

        if (modifiedInInv) {
            fs.writeFileSync(inInvPath, JSON.stringify([{ _updatedt: new Date().toISOString() }, ...items], null, 2), 'utf8');
        }

        if (itemsToSell.length > 0) {
            console.log(`[Scheduler] 发现 ${itemsToSell.length} 件符合条件的饰品，正在触发自动上架...`);
            
            const username = settings.AuthUsername || 'admin';
            const password = settings.AuthPassword || '123456';
            const auth = Buffer.from(`${username}:${password}`).toString('base64');
            
            const postData = JSON.stringify({ items: itemsToSell });

            const options = {
                hostname: '127.0.0.1',
                port: 9998,
                path: '/api/steam/sell',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Authorization': `Basic ${auth}`
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    console.log(`[Scheduler] 自动上架请求完成，API 响应: ${data}`);
                });
            });

            req.on('error', (e) => {
                console.error(`[Scheduler] 自动上架请求异常: ${e.message}`);
            });

            req.write(postData);
            req.end();
        }
    } catch (e) {
        console.error(`[Scheduler] 自动出售任务异常:`, e.message);
        try { require('./utils/notify').notify(`[失败] 计划任务 (自动出售) 异常: ${e.message}`); } catch(err){}
    }
}

function checkFiveMinuteTasks() {
    if (steamRouter.checkPendingConfirmations) {
        steamRouter.checkPendingConfirmations().catch(e => {
            console.error(`[Scheduler] 5-minute task failed: ${e.message}`);
            try { require('./utils/notify').notify(`[失败] 计划任务 (自动确认) 异常: ${e.message}`); } catch(err){}
        });
    }
}

function runAutoSellWrapper() {
    checkAutoSellTradableItems().catch(e => {
        console.error(`[Scheduler] Auto sell task failed:`, e);
        try { require('./utils/notify').notify(`[失败] 计划任务 (自动出售) 异常: ${e.message}`); } catch(err){}
    });
}

// 1 Hour interval
setInterval(() => {
    checkAndRunScheduler();
    runAutoSellWrapper();
}, 1000 * 60 * 60);

// 24 Hour interval (explicit daily check, although the hourly check also triggers it)
setInterval(() => {
    runAutoSellWrapper();
}, 1000 * 60 * 60 * 24);

// 5 Minute interval
setInterval(checkFiveMinuteTasks, 1000 * 60 * 5);

// Initial run
// checkAndRunScheduler();
setTimeout(checkFiveMinuteTasks, 5000); // Check shortly after startup
setTimeout(() => runAutoSellWrapper(), 10000); // Initial check 10 seconds after startup
