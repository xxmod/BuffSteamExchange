const fs = require('fs');
const path = require('path');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

// 1. 参数解析
const args = process.argv.slice(2);
const isUpdate = args.includes('--update') || args.includes('-u');

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

// 3. 登录获取 Cookie
console.log("正在准备登录 Steam...");
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

const sessionOpts = {};
if (proxyUrl) {
    console.log(`[提示] 检测到代理: ${proxyUrl}`);
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
    // 组装 steamcommunity，强制指定语言为简体中文
    const request = require('request');
    const communityOpts = { language: 'schinese' };
    if (proxyUrl) {
        communityOpts.request = request.defaults({ proxy: proxyUrl });
    }
    
    const community = new SteamCommunity(communityOpts);
    community.setCookies(cookies);
    
    console.log("正在拉取 CSGO 库存信息...");
    
    // 从 session 中提取 64 位 SteamID
    const steamId64 = typeof session.steamID.getSteamID64 === 'function' ? session.steamID.getSteamID64() : session.steamID.toString();
    
    // 730 = CSGO, 2 = Context ID (标准物品库存), false = 包含所有物品(不仅是可交易的)
    community.getUserInventoryContents(steamId64, 730, 2, false, (err, inventory) => {
        if (err) {
            console.error("获取库存失败:", err.message);
            process.exit(1);
        }

        console.log(`成功拉取到 ${inventory.length} 件物品，正在解析数据...`);
        
        const parsedItems = inventory.map(item => {
            let tradeUnlockTime = null;
            if (item.cache_expiration) {
                try {
                    tradeUnlockTime = new Date(item.cache_expiration).toISOString();
                } catch (e) {
                    tradeUnlockTime = item.cache_expiration;
                }
            }

            let wear = null;
            if (item.tags && Array.isArray(item.tags)) {
                const exteriorTag = item.tags.find(t => t.category === 'Exterior');
                if (exteriorTag) {
                    wear = exteriorTag.localized_tag_name || exteriorTag.name;
                }
            }

            return {
                id: item.id,
                name: item.market_name || item.name,
                tradable: item.tradable,
                tradeUnlockTime: tradeUnlockTime,
                wear: wear
            };
        });

        const inventoryPath = path.resolve(__dirname, 'inventory.json');
        
        if (isUpdate) {
            let oldItems = [];
            if (fs.existsSync(inventoryPath)) {
                try {
                    const raw = fs.readFileSync(inventoryPath, 'utf8');
                    oldItems = JSON.parse(raw);
                } catch (e) {
                    console.error("读取旧 inventory.json 失败，视为空库存处理。");
                }

                const oldIds = new Set(oldItems.map(i => i.id));
                const newItems = parsedItems.filter(i => !oldIds.has(i.id));
                
                console.log(`\n================ 新增物品 (${newItems.length} 件) ================`);
                console.log(JSON.stringify(newItems, null, 2));
                console.log("==================================================\n");
            } else {
                console.log("没有找到旧文件，本次获取的全部被视为新增物品：");
                console.log(JSON.stringify(parsedItems, null, 2));
            }
            
            fs.writeFileSync(inventoryPath, JSON.stringify(parsedItems, null, 2));
            console.log(`最新的库存快照已经更新至 ${inventoryPath}`);
            
        } else {
            fs.writeFileSync(inventoryPath, JSON.stringify(parsedItems, null, 2));
            console.log(`已将完整库存（共 ${parsedItems.length} 件）提取并保存到: ${inventoryPath}`);
        }

        process.exit(0);
    });

}).catch(err => {
    console.error("执行时发生异常:", err.message);
    process.exit(1);
});
