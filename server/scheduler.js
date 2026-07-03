const fs = require('fs');
const path = require('path');
// const { updateBuffItems } = require('./api/buff'); // Later
// const { updateSteamInventory } = require('./api/steam'); // Later

const dataDir = path.join(__dirname, '../data');

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
                const items = JSON.parse(fs.readFileSync(inInvPath, 'utf8'));
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

// 1 Hour interval
setInterval(checkAndRunScheduler, 1000 * 60 * 60);

// Initial run
// checkAndRunScheduler();
