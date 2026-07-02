const fs = require('fs');
const path = require('path');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

// 1. 参数解析
const args = process.argv.slice(2);
let itemId = null;
let price = null; // 输入为你期望到手的价格（例如 100.50）

for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i' || args[i] === '--item') {
        itemId = args[++i];
    } else if (args[i] === '-p' || args[i] === '--price') {
        price = parseFloat(args[++i]);
    }
}

if (!itemId || !price) {
    console.error("用法: node sellSteamMarket.js -i <物品ID> -p <期望到手价格>");
    console.error("参数:");
    console.error("  -i, --item      Steam 物品ID (assetid)");
    console.error("  -p, --price     期望到手的价格（数字，无需考虑Steam税费，例如 12.5）");
    process.exit(1);
}

// 转换价格为「分」 (cents)，因为 Steam API 接收的单位是最小货币单位（分）
const priceWithoutFee = Math.round(price * 100);

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

const sessionFilePath = path.resolve(__dirname, 'steam_session.json');

async function doLogin() {
    let savedToken = null;
    if (fs.existsSync(sessionFilePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
            savedToken = data.refreshToken;
        } catch (e) {}
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

    community.sellItem(appid, contextid, itemId, amount, priceWithoutFee, function(err) {
        if (err) {
            console.error("上架提交失败:", err.message);
            process.exit(1);
        } else {
            console.log(`物品上架请求提交成功！`);
            console.log(`物品ID: ${itemId}, 期望到手价: ${price}`);
            console.log("====================================");
            console.log("（由于您要求不需要完成二步确认交易步骤，请稍后前往手机 Steam 或使用确认脚本进行市场挂单确认）");
            process.exit(0);
        }
    });

}).catch(err => {
    console.error("执行时发生异常:", err.message);
    process.exit(1);
});
