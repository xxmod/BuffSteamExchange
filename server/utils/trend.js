function analyzePriceHistory(prices) {
    if (!prices || prices.length < 30) return null;
    
    // Support both String (Steam format: "MMM DD YYYY HH: +0") and Number (Buff timestamp)
    prices.sort((a, b) => {
        const timeA = typeof a[0] === 'string' ? new Date(a[0].substring(0, 11)).getTime() : a[0];
        const timeB = typeof b[0] === 'string' ? new Date(b[0].substring(0, 11)).getTime() : b[0];
        return timeA - timeB;
    });
    
    // We need at least the last 30 data points
    const recentPrices = prices.slice(-30);
    const n = recentPrices.length;

    // 1. Calculate Slope (Linear Regression on the last 30 days)
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
    const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;

    // 2. Calculate SMA(7) and SMA(30)
    let sum30 = 0;
    let sum7 = 0;
    for (let i = 0; i < n; i++) {
        sum30 += recentPrices[i][1];
        if (i >= n - 7) sum7 += recentPrices[i][1];
    }
    const sma30 = sum30 / 30;
    const sma7 = sum7 / 7;

    // 3. Calculate RSI(14)
    const rsiPrices = prices.slice(-15); // We need 15 days to get 14 differences
    let gains = 0, losses = 0;
    for (let i = 1; i < rsiPrices.length; i++) {
        const diff = rsiPrices[i][1] - rsiPrices[i - 1][1];
        if (diff >= 0) gains += diff;
        else losses -= diff; // Absolute value
    }
    let rsi14 = 50; // Default if flat
    if (gains === 0 && losses === 0) {
        rsi14 = 50;
    } else if (losses === 0) {
        rsi14 = 100;
    } else if (gains === 0) {
        rsi14 = 0;
    } else {
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        const rs = avgGain / avgLoss;
        rsi14 = 100 - (100 / (1 + rs));
    }

    return { slope, sma7, sma30, rsi14 };
}

module.exports = {
    analyzePriceHistory
};
