const fs = require('fs');
const path = require('path');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

// 1. 参数解析
const args = process.argv.slice(2);
let itemId = null;
let price = null; // 输入为你期望到手的价格（例如 100.50）
let feePrice = null; // 输入为买家支付的含税价格

for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i' || args[i] === '--item') {
        itemId = args[++i];
    } else if (args[i] === '-p' || args[i] === '--price') {
        price = parseFloat(args[++i]);
    } else if (args[i] === '-f' || args[i] === '--feeprice') {
        feePrice = parseFloat(args[++i]);
    }
}

if (!itemId || (!price && !feePrice)) {
    console.error("用法: node sellSteamMarket.js -i <物品ID> [-p <期望到手价格> | -f <含税挂单价格>]");
    console.error("参数:");
    console.error("  -i, --item      Steam 物品ID (assetid)");
    console.error("  -p, --price     期望到手的价格（税前，您实际收到的钱，例如 12.5）");
    console.error("  -f, --feeprice  含税挂单价格（税后，买家实际支付的钱，例如 14.37）");
    process.exit(1);
}

// 转换价格为「分」 (cents)，计算税费
let priceWithoutFee;
let priceWithFee;

if (price) {
    priceWithoutFee = Math.round(price * 100);
    const steamFee = Math.max(1, Math.floor(priceWithoutFee * 0.05));
    const pubFee = Math.max(1, Math.floor(priceWithoutFee * 0.10));
    priceWithFee = priceWithoutFee + steamFee + pubFee;
} else if (feePrice) {
    priceWithFee = Math.round(feePrice * 100);
    let estimated = Math.floor(priceWithFee / 1.15);
    let found = false;
    for (let i = estimated - 5; i <= estimated + 5; i++) {
        if (i <= 0) continue;
        let sFee = Math.max(1, Math.floor(i * 0.05));
        let pFee = Math.max(1, Math.floor(i * 0.10));
        if (i + sFee + pFee === priceWithFee) {
            priceWithoutFee = i;
            found = true;
            break;
        }
    }
    if (!found) {
        priceWithoutFee = estimated;
    }
}

// 2. 读取并解析 .env
const envPath = path.resolve(__dirname, '.env');
if (!fs.existsSync(envPath)) {
    console.error("未找到 .env 文件");
    process.exit(1);
}

const envVars = {};
fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    if (!line || line.startsWith('#')) return;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        envVars[match[1].trim()] = match[2].trim();
    }
});

function decodeBase64(str) {
    if (!str) return '';
    return Buffer.from(str, 'base64').toString('utf8');
}

const accountName = decodeBase64(envVars.SteamAccount);
const password = decodeBase64(envVars.SteamPassword);
const sharedSecret = envVars.SharedSecret;
const identitySecret = envVars.IdentitySecret;

if (!accountName || !password || !sharedSecret || !identitySecret) {
    console.error("凭证不完整，请确保 .env 中包含 SteamAccount, SteamPassword, SharedSecret, IdentitySecret");
    process.exit(1);
}

// 3. 登录并提交上架
console.log("正在准备登录 Steam...");
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

const sessionOpts = {};
if (proxyUrl) {
    console.log(`[提示] 底层已检测到代理环境变量: ${proxyUrl}，正在配置 steam-session 代理...`);
    sessionOpts.httpProxy = proxyUrl;
}

const session = new LoginSession(EAuthTokenPlatformType.WebBrowser, sessionOpts);

const dataDir = path.resolve(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
const sessionFilePath = path.resolve(dataDir, 'steam_session.json');

async function doLogin() {
    let savedToken = null;
    if (fs.existsSync(sessionFilePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
            savedToken = data.refreshToken;
        } catch (e) { }
    }

    if (savedToken) {
        console.log("检测到本地会话凭证，正在尝试免密恢复...");
        session.refreshToken = savedToken;
        try {
            const cookies = await session.getWebCookies();
            console.log("免密恢复成功！");
            return cookies;
        } catch (e) {
            console.log("会话凭证已过期或无效，将自动重新进行账号密码安全登录...");
        }
    }

    console.log("正在重新连接并进行账号密码二次验证...");

    return new Promise((resolve, reject) => {
        session.startWithCredentials({
            accountName: accountName,
            password: password,
            steamGuardCode: SteamTotp.generateAuthCode(sharedSecret)
        }).then((response) => {
            if (response.actionRequired) {
                reject(new Error(`登录失败: 需要额外的验证动作。\n${JSON.stringify(response.validActions, null, 2)}`));
            }
        }).catch(err => {
            reject(new Error(`登录异常: ${err.message}`));
        });

        session.on('authenticated', async () => {
            console.log("账号验证通过，正在保存持久化会话...");
            try {
                fs.writeFileSync(sessionFilePath, JSON.stringify({
                    refreshToken: session.refreshToken
                }, null, 2));

                const cookies = await session.getWebCookies();
                resolve(cookies);
            } catch (e) {
                reject(new Error(`获取网页 Cookies 失败: ${e.message}`));
            }
        });

        session.on('error', (err) => {
            reject(new Error(`Steam Session 错误: ${err.message}`));
        });

        session.on('timeout', () => {
            reject(new Error(`登录请求超时，请检查您的代理配置。`));
        });
    });
}

doLogin().then(async (cookies) => {
    const request = require('request');
    const community = new SteamCommunity(proxyUrl ? {
        request: request.defaults({ proxy: proxyUrl })
    } : {});

    community.setCookies(cookies);
    console.log(`登录系统构建成功！正在提交物品 [${itemId}] 上架请求...`);

    // 提交上架请求
    // appid = 730 (CSGO), contextid = 2, assetid = itemId, amount = 1
    const appid = 730;
    const contextid = 2;
    const amount = 1;

    community.httpRequestPost({
        url: 'https://steamcommunity.com/market/sellitem/',
        form: {
            sessionid: community.getSessionID(),
            appid: 730,
            contextid: 2,
            assetid: itemId,
            amount: 1,
            price: priceWithoutFee
        },
        headers: {
            'Referer': 'https://steamcommunity.com/my/inventory/'
        }
    }, function (err, response, body) {
        if (err) {
            console.error("上架提交失败:", err.message);
            process.exit(1);
        }
        try {
            const data = JSON.parse(body);
            if (data.success) {
                console.log(`物品上架请求提交成功！`);
                console.log(`物品ID: ${itemId}, 期望到手价(税前单价): ${priceWithoutFee / 100}, 买家支付价(税后单价): ${priceWithFee / 100}`);
                process.exit(0);
            } else {
                console.error("上架提交被拒绝: Steam 返回错误 - ", data.message || body);
                process.exit(1);
            }
        } catch (e) {
            console.error("解析 Steam 返回数据失败:", body);
            process.exit(1);
        }
    });

}).catch(err => {
    console.error("执行时发生异常:", err.message);
    process.exit(1);
});
