const fs = require('fs');
const path = require('path');
const https = require('https');
let HttpsProxyAgent;
try {
    HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
} catch (e) {
    // 如果没有安装代理模块，则忽略
}

// 为了兼容低版本 Node.js，包装 https.get 方法
function fetchJson(url, cookie = '') {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };
        if (cookie) {
            options.headers['Cookie'] = cookie;
        }

        // 如果设置了代理环境变量，则使用代理
        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
        if (proxyUrl && HttpsProxyAgent) {
            options.agent = new HttpsProxyAgent(proxyUrl);
        }

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 429) {
                    return resolve({ error: '429', message: 'Rate limited' });
                }
                if (res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode} - ${data.substring(0, 100)}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`JSON 解析失败, 状态码: ${res.statusCode}, 响应前段: ${data.substring(0, 100)}`));
                }
            });
        }).on('error', reject);
    });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSteamData(marketHashName, appid = 730) {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=${appid}&currency=23&market_hash_name=${encodeURIComponent(marketHashName)}`;
    try {
        const data = await fetchJson(url);
        if (data && data.error === '429') {
            return { volume: 'Steam API 限制(429)', price: 'Steam API 限制(429)' };
        }

        let volume = 0;
        let price = '无数据';

        if (data && data.volume) {
            volume = parseInt(data.volume.replace(/,/g, ''));
        }

        if (data && data.lowest_price) {
            // steam 价格带有货币符号，如 "¥ 28.53"，用正则提取数字
            const match = data.lowest_price.match(/[\d.]+/);
            if (match) {
                price = parseFloat(match[0]);
            }
        }

        return { volume, price };
    } catch (e) {
        return { volume: `错误: ${e.message}`, price: `错误: ${e.message}` };
    }
}

async function main() {
    try {
        // 读取 .env 中的 Cookie
        const envPath = path.resolve(__dirname, '.env');
        if (!fs.existsSync(envPath)) {
            throw new Error(`找不到 .env 文件: ${envPath}`);
        }

        const envContent = fs.readFileSync(envPath, 'utf-8');
        const cookieMatch = envContent.match(/BuffCookie=(.*)/);
        if (!cookieMatch || !cookieMatch[1]) {
            throw new Error('在 .env 中未找到 BuffCookie 字段');
        }
        const cookie = cookieMatch[1].trim();

        const maxItems = 500;
        let results = [];
        let pageNum = 1;

        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
        if (proxyUrl) {
            console.error(`[系统提示] 检测到代理配置: ${proxyUrl}，正在通过代理发送请求...`);
        } else {
            console.error(`[系统提示] 未检测到代理环境变量，将直接连接...`);
        }

        console.error("开始获取数据，Steam API 需要逐个请求，可能需要较长时间并可能触发429限流...");

        // Buff 列表接口默认每页返回数据，抓取 500 条
        while (results.length < maxItems) {
            // 注意：API的查询参数可能随着网站更新变化，此处以最常见的按在售数量倒序为例
            const url = `https://buff.163.com/api/market/goods?game=csgo&page_num=${pageNum}&sort_by=sell_num.desc`;

            const data = await fetchJson(url, cookie);

            if (data.code !== 'OK') {
                throw new Error(`API 响应错误: ${data.error || JSON.stringify(data)}`);
            }

            const items = data.data.items || [];
            if (items.length === 0) break; // 没有更多数据了

            for (const item of items) {
                if (results.length >= maxItems) break;

                // 仿照 tempermonkey.js 逻辑，请求 steamcommunity.com 的 priceoverview 接口
                // buff 接口通常提供 market_hash_name
                const hashName = item.market_hash_name || item.name;
                const steamData = await fetchSteamData(hashName, 730);

                console.log(`物品ID：${item.id}`);
                console.log(`物品名：${item.name}`);
                console.log(`最低价：${item.sell_min_price}`);
                console.log(`在售量：${item.sell_num}`);
                console.log(`Steam最低价：${steamData.price}`);
                console.log(`Steam24小时销量：${steamData.volume}\n`);

                results.push({
                    id: item.id,
                    name: item.name,
                    sell_min_price: item.sell_min_price,
                    sell_num: item.sell_num,
                    steam_min_price: steamData.price,
                    volume_24h: steamData.volume
                });

                // 为防止过快被 Steam ban，每次请求加一个小延迟
                await delay(4000);
            }

            if (results.length >= maxItems) break;

            pageNum++;
        }

        // 将数据保存到同目录下的 buff_item.json
        const outputPath = path.resolve(__dirname, 'buff_item.json');
        fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
        console.log(`\n抓取完成，数据已保存至: ${outputPath}`);

    } catch (error) {
        console.error(JSON.stringify({ error: error.message }));
        process.exit(1);
    }
}

main();
