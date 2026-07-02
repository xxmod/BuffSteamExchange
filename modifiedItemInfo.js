const fs = require('fs');
const path = require('path');

const inputPath = path.resolve(__dirname, './data/buff_item.json');

// 检查是否为合法数字（剔除包含中文、字母、特殊符号等非数字内容）
function isValidNumber(val) {
    if (val === null || val === undefined) return false;

    // 转换为字符串，去除首尾空格
    const strVal = String(val).trim();
    if (strVal === '') return false;

    // 使用内置 Number 转换，如果包含非法字符（如 "无数据" 或 "错误..."），会返回 NaN
    const num = Number(strVal);
    return !isNaN(num);
}

function main() {
    if (!fs.existsSync(inputPath)) {
        console.error(`找不到文件: ${inputPath}`);
        return;
    }

    try {
        const rawData = fs.readFileSync(inputPath, 'utf-8');
        const items = JSON.parse(rawData);

        const filteredItems = [];

        for (const item of items) {
            const { volume_24h, steam_min_price, sell_num, sell_min_price } = item;

            // 验证指定字段是否全为合法数字，并且剔除价格极低（< 0.2）的商品
            if (
                isValidNumber(volume_24h) &&
                isValidNumber(steam_min_price) &&
                isValidNumber(sell_num) &&
                isValidNumber(sell_min_price) &&
                parseFloat(sell_min_price) >= 0.2
            ) {
                // 所有字段合法，计算 discount_rate
                // 根据常见交易逻辑及您的公式，计算 购买成本 / (Steam售价 * 0.85税后) 的比例
                const buffPrice = parseFloat(sell_min_price);
                const steamPrice = parseFloat(steam_min_price);

                // 为了防止 steamPrice 为 0 导致 Infinity
                if (steamPrice > 0) {
                    const discount_rate = buffPrice / (0.85 * steamPrice);
                    // 保留4位小数方便阅读
                    item.discount_rate = Number(discount_rate.toFixed(4));
                    filteredItems.push(item);
                }
            }
        }

        // 将清洗后的结果写回 ./data/buff_item.json（或者新建文件），这里直接覆盖修改原文件
        fs.writeFileSync(inputPath, JSON.stringify(filteredItems, null, 2));
        console.log(`处理完成！原始数据 ${items.length} 条，清洗后保留 ${filteredItems.length} 条有效数据。已覆盖保存至 ${inputPath}`);

    } catch (e) {
        console.error('处理文件时发生错误:', e);
    }
}

main();
