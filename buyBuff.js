const fs = require('fs');
const path = require('path');
const https = require('https');

// 解析命令行参数
const args = process.argv.slice(2);
let itemId = null;
let number = 1;
let payment = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i' || args[i] === '--item') {
        itemId = args[++i];
    } else if (args[i] === '-n' || args[i] === '--number') {
        number = parseInt(args[++i], 10);
    } else if (args[i] === '-p' || args[i] === '--payment') {
        payment = parseInt(args[++i], 10);
    }
}

if (!itemId || !payment) {
    console.error("用法: node buyBuff.js -i <物品ID> -n <购买数量> -p <支付方式>");
    console.error("参数:");
    console.error("  -i, --item      物品ID (例如: 35086)");
    console.error("  -n, --number    购买数量 (默认: 1)");
    console.error("  -p, --payment   付款方式 (1为余额, 2为微信支付, 3为支付宝支付)");
    process.exit(1);
}

// 支付方式映射
// 1 = 余额 (通常在Buff中为 3 或者是支付宝直接扣)
// 2 = 微信 (6)
// 3 = 支付宝 (51)
const paymentMap = {
    1: 3, // 余额
    2: 6, // 微信支付
    3: 51 // 支付宝支付
};
const payMethodId = paymentMap[payment] || 3;

// 读取 BuffCookie
const envPath = path.join(__dirname, '.env');
let buffCookie = '';
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^BuffCookie=(.*)$/m);
    if (match) {
        // 格式化 Cookie，使其符合标准规范
        buffCookie = match[1].trim().split(';').map(c => c.trim()).filter(c => c).join('; ');
    }
}

if (!buffCookie) {
    console.error("错误: 在 .env 文件中找不到 BuffCookie");
    process.exit(1);
}

// 提取 csrf_token
let csrfToken = '';
const csrfMatch = buffCookie.match(/csrf_token=([^;]+)/);
if (csrfMatch) {
    csrfToken = csrfMatch[1].replace(/^"|"$/g, '');
}

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

// 封装 HTTP 请求
function requestBuff(url, method = 'GET', data = null) {
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
        const req = require('https').request(options, (res) => {
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
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    console.log(`开始购买物品: ${itemId}, 购买数量: ${number}, 支付方式: ${payment}`);
    
    // 获取卖家列表
    const sellOrderUrl = `https://buff.163.com/api/market/goods/sell_order?game=csgo&goods_id=${itemId}&page_num=1&sort_by=default&allow_tradable_cooldown=1&_=${Date.now()}`;
    
    try {
        const sellRes = await requestBuff(sellOrderUrl);
        if (sellRes.code !== 'OK') {
            console.error("获取卖家列表失败:", sellRes.error || sellRes.msg || sellRes.code);
            return;
        }
        
        let items = sellRes.data.items || [];
        if (items.length === 0) {
            console.log("当前无人在售该物品。");
            return;
        }
        
        let bought = 0;
        for (let item of items) {
            if (bought >= number) break;
            
            console.log(`尝试购买来自卖家 [${item.user_id}] 的物品, 价格: ${item.price}...`);
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
            if (payMethodId === 51) {
                payload.steamid = null;
            }
            
            const buyUrl = "https://buff.163.com/api/market/goods/buy";
            const buyRes = await requestBuff(buyUrl, 'POST', payload);
            
            if (buyRes.code === 'OK') {
                const orderId = buyRes.data.id;
                console.log(`锁单成功! 订单号: ${orderId}`);
                bought++;
                
                // 获取支付链接 (微信 / 支付宝)
                if (payment === 2) {
                    const wxUrl = `https://buff.163.com/api/market/bill_order/wx_pay_qrcode?bill_order_id=${orderId}&_=${Date.now()}`;
                    const wxRes = await requestBuff(wxUrl);
                    if (wxRes.code === 'OK') {
                        const payUrl = wxRes.data.url || (wxRes.data.elements_v2 && wxRes.data.elements_v2.wechatpay ? wxRes.data.elements_v2.wechatpay.url : null);
                        if (payUrl) console.log("微信支付二维码链接:", payUrl);
                    }
                } else if (payment === 3) {
                    const aliUrl = `https://buff.163.com/api/market/bill_order/page_pay?bill_order_id=${orderId}&_=${Date.now()}`;
                    const aliRes = await requestBuff(aliUrl);
                    if (aliRes.code === 'OK') {
                        let payUrl = null;
                        if (aliRes.data.elements_v2 && aliRes.data.elements_v2.alipay) {
                            payUrl = aliRes.data.elements_v2.alipay.url;
                        } else if (aliRes.data.elements) {
                            payUrl = aliRes.data.elements.url;
                        } else {
                            payUrl = aliRes.data.url;
                        }
                        if (payUrl) console.log("支付宝支付链接:", payUrl);
                    }
                } else {
                    console.log("选择余额支付, 请检查Buff账户是否已成功扣款。");
                }
            } else {
                console.error(`锁单失败: ${buyRes.error || buyRes.msg || buyRes.code}`);
                // 如果是冷却时间，可能需要等一等
                if (buyRes.code === 'COOLING_DOWN') {
                    console.log("触发频率限制或存在未付款订单，建议稍后再试。");
                    break;
                }
            }
            
            if (bought < number) {
                await delay(1000); // 间隔1秒继续购买
            }
        }
        
        console.log(`购买流程结束。成功锁单数: ${bought}/${number}`);
    } catch (e) {
        console.error("发生异常:", e);
    }
}

main();
