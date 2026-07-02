const fs = require('fs');
const path = require('path');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');

// 1. 参数解析
const args = process.argv.slice(2);
const isConfirm = args.includes('--confirm') || args.includes('-c');
const isToken = args.includes('--token') || args.includes('-t');

if (!isConfirm && !isToken) {
    console.log("请指定参数: \n  --confirm (-c) 确认市场交易\n  --token (-t)   获取并显示令牌\n  (可以同时指定这两个参数)");
    process.exit(0);
}

// 2. 读取并解析 .env
const envPath = path.resolve(__dirname, '.env');
if (!fs.existsSync(envPath)) {
    console.error("未找到 .env 文件");
    process.exit(1);
}

const envVars = {};
fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    // 忽略空行或注释
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

// 按照题意，除 DeviceId 以外的密码学字段都经过了 Base64 编码（账户名密码是我们自己编的，需要解回明文）
const accountName = decodeBase64(envVars.SteamAccount);
const password = decodeBase64(envVars.SteamPassword);
// 令牌库要求的 SharedSecret 和 IdentitySecret 已经是 Steam 默认的 Base64 格式，直接使用
const sharedSecret = envVars.SharedSecret; 
const identitySecret = envVars.IdentitySecret; 

if (!accountName || !password || !sharedSecret || !identitySecret) {
    console.error("凭证不完整，请确保 .env 中包含 SteamAccount, SteamPassword, SharedSecret, IdentitySecret");
    process.exit(1);
}

// 3. 生成令牌
if (isToken) {
    try {
        const code = SteamTotp.generateAuthCode(sharedSecret);
        console.log(`======================`);
        console.log(`Steam 令牌: ${code}`);
        console.log(`======================`);
    } catch (e) {
        console.error("生成令牌失败，请检查 SharedSecret 是否正确:", e.message);
    }
    
    if (!isConfirm) {
        process.exit(0);
    }
}

// 4. 登录与确认交易
if (isConfirm) {
    console.log("正在准备登录 Steam...");
    
    const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    
    const sessionOpts = {};
    if (proxyUrl) {
        console.log(`[提示] 底层已检测到代理环境变量: ${proxyUrl}，正在配置 steam-session 代理...`);
        sessionOpts.httpProxy = proxyUrl;
    } else {
        console.log(`[提示] 未检测到代理环境变量，将尝试直连（如果超时请设置 HTTPS_PROXY）。`);
    }

    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser, sessionOpts);

    console.log("正在连接并进行二次验证...");
    
    session.startWithCredentials({
        accountName: accountName,
        password: password,
        steamGuardCode: SteamTotp.generateAuthCode(sharedSecret)
    }).then((response) => {
        if (response.actionRequired) {
            console.error("登录失败: 需要额外的验证动作，当前的自动化流程无法继续。");
            process.exit(1);
        }
    }).catch(err => {
        console.error("登录异常:", err.message);
        process.exit(1);
    });

    session.on('authenticated', async () => {
        console.log("账号认证通过，正在获取网页 Cookies...");
        try {
            const cookies = await session.getWebCookies();
            
            // 将 Cookies 传给 steamcommunity，继续进行市场确认
            const request = require('request');
            const community = new SteamCommunity(proxyUrl ? {
                request: request.defaults({ proxy: proxyUrl })
            } : {});
            
            community.setCookies(cookies);
            console.log("登录系统构建成功！正在获取需要确认的交易/市场挂单...");

            const time = Math.floor(Date.now() / 1000);
            const confKey = SteamTotp.getConfirmationKey(identitySecret, time, 'conf');
            const allowKey = SteamTotp.getConfirmationKey(identitySecret, time, 'allow');
            
            community.acceptAllConfirmations(time, confKey, allowKey, function(err, confirmations) {
                if (err) {
                    console.error("确认操作失败:", err.message);
                    process.exit(1);
                } else {
                    if (confirmations && confirmations.length > 0) {
                        console.log(`成功确认了 ${confirmations.length} 个交易/市场报价。`);
                    } else {
                        console.log("当前没有任何需要确认的交易或市场挂单。");
                    }
                }
                process.exit(0);
            });
        } catch (e) {
            console.error("获取 Cookies 失败:", e.message);
            process.exit(1);
        }
    });

    session.on('error', (err) => {
        console.error("Steam Session 发生错误:", err.message);
        process.exit(1);
    });
    
    session.on('timeout', () => {
        console.error("登录请求超时，请检查代理是否正常工作。");
        process.exit(1);
    });
}
