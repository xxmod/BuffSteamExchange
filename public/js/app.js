document.addEventListener('DOMContentLoaded', () => {
    // Nav Routing
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(n => n.classList.remove('active'));
            pages.forEach(p => p.classList.remove('active'));
            item.classList.add('active');
            const pageId = item.getAttribute('data-page');
            document.getElementById(`page-${pageId}`).classList.add('active');
            loadPageData(pageId);
        });
    });

    // API Helpers
    const apiGet = async (url) => (await fetch(url)).json();
    const apiPost = async (url, data) => (await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    })).json();

    // Data stores
    let buffItems = [];
    let ownedItems = [];

    // Page Loaders
    async function loadPageData(pageId) {
        if (pageId === 'settings') loadSettings();
        else if (pageId === 'buy') loadBuffItems();
        else if (pageId === 'inventory') loadInventory();
        else if (pageId === 'owned') loadOwned();
        else if (pageId === 'account') loadAccount();
        else if (pageId === 'history') loadHistory();
        else if (pageId === 'logs') loadLogs();
    }

    // --- Settings ---
    async function loadSettings() {
        const { env, settings } = await apiGet('/api/settings');
        const form = document.getElementById('env-form');
        form.innerHTML = '';
        Object.keys(env).forEach(k => {
            form.innerHTML += `
                <div style="margin-bottom:12px;">
                    <label class="body-sm" style="display:block;margin-bottom:4px;">${k}</label>
                    <input type="text" class="text-input env-input" data-key="${k}" value="${env[k]}">
                </div>
            `;
        });
        
        const autoConfirmCb = document.getElementById('setting-auto-confirm');
        if (autoConfirmCb) {
            autoConfirmCb.checked = !!settings.autoConfirmListings;
        }

        const buffMaxInput = document.getElementById('setting-buff-max');
        if (buffMaxInput) buffMaxInput.value = settings.BuffMaxItems || '';

        const buffExcludeInput = document.getElementById('setting-buff-exclude');
        if (buffExcludeInput) buffExcludeInput.value = settings.BuffExcludeKeywords || '';
    }

    document.getElementById('save-env-btn').addEventListener('click', async () => {
        const env = {};
        document.querySelectorAll('.env-input').forEach(input => {
            env[input.getAttribute('data-key')] = input.value;
        });
        const res = await apiPost('/api/settings', { env });
        if (res.success) alert("环境变量已保存！");
    });

    document.getElementById('restart-backend-btn').addEventListener('click', async () => {
        if (confirm("确定要重启后端服务吗？\n（如果您是使用 npm start 启动的服务，后台将在1秒后自动重启，网页将会暂时无响应，稍后刷新即可）")) {
            await apiPost('/api/settings/restart', {});
            alert("后端重启指令已发送！如果您使用 npm start 运行，服务将自动恢复。稍等几秒后请刷新网页。");
        }
    });

    const saveSettingsBtn = document.getElementById('save-settings-btn');
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
            const settings = {
                autoConfirmListings: document.getElementById('setting-auto-confirm').checked,
                BuffMaxItems: document.getElementById('setting-buff-max').value,
                BuffExcludeKeywords: document.getElementById('setting-buff-exclude').value
            };
            const res = await apiPost('/api/settings', { settings });
            if (res.success) alert("系统配置已保存！");
        });
    }

    document.getElementById('export-backup-btn').addEventListener('click', () => {
        window.location.href = '/api/settings/export';
    });

    document.getElementById('import-backup-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                const res = await apiPost('/api/settings/import', data);
                if (res.success) {
                    alert("备份导入成功！");
                    loadSettings();
                } else alert(res.error);
            } catch (err) { alert("无效的 JSON 文件"); }
        };
        reader.readAsText(file);
    });

    // --- Buy ---
    let currentSort = { key: 'discount_rate', asc: true };
    async function loadBuffItems() {
        buffItems = await apiGet('/api/buff/items');
        sortAndRenderBuffItems();
    }
    
    function sortAndRenderBuffItems() {
        let items = [...buffItems];
        // Apply search filters if any
        const qInclude = document.getElementById('search-buff-input').value.toLowerCase();
        const qExclude = document.getElementById('exclude-buff-input').value.toLowerCase();
        
        if (qInclude) {
            // Support multiple include keywords separated by space
            const includes = qInclude.split(/\s+/).filter(k => k);
            items = items.filter(i => includes.every(k => i.name.toLowerCase().includes(k)));
        }
        
        if (qExclude) {
            // Support multiple exclude keywords separated by space
            const excludes = qExclude.split(/\s+/).filter(k => k);
            items = items.filter(i => !excludes.some(k => i.name.toLowerCase().includes(k)));
        }

        // Sort
        items.sort((a, b) => {
            let valA = a[currentSort.key];
            let valB = b[currentSort.key];
            if (valA === undefined || valA === null || valA === 'N/A') valA = -999999;
            if (valB === undefined || valB === null || valB === 'N/A') valB = -999999;
            
            if (currentSort.key === 'name') {
                return currentSort.asc ? String(valA).localeCompare(String(valB)) : String(valB).localeCompare(String(valA));
            } else {
                return currentSort.asc ? Number(valA) - Number(valB) : Number(valB) - Number(valA);
            }
        });

        renderBuffItems(items);
    }
    
    function renderBuffItems(items) {
        const tbody = document.getElementById('buff-items-body');
        tbody.innerHTML = items.map((item, i) => {
            // Find real index in buffItems to ensure checkboxes map correctly
            const realIdx = buffItems.findIndex(b => b.id === item.id);
            return `
            <tr>
                <td><input type="checkbox" class="buy-checkbox" data-index="${realIdx}"></td>
                <td>${item.name}</td>
                <td>${item.sell_num}</td>
                <td>¥${item.sell_min_price}</td>
                <td>¥${item.steam_min_price}</td>
                <td style="color:var(--colors-primary); font-weight:500;">${item.discount_rate || 'N/A'}</td>
                <td><input type="number" class="text-input buy-qty" value="1" min="1" max="100" style="width:70px;"></td>
            </tr>
            `;
        }).join('');
    }

    document.querySelectorAll('.sort-column').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.getAttribute('data-sort');
            if (currentSort.key === key) {
                currentSort.asc = !currentSort.asc;
            } else {
                currentSort.key = key;
                currentSort.asc = true;
            }
            sortAndRenderBuffItems();
        });
    });

    document.getElementById('search-buff-input').addEventListener('input', () => {
        sortAndRenderBuffItems();
    });

    document.getElementById('exclude-buff-input').addEventListener('input', () => {
        sortAndRenderBuffItems();
    });

    document.getElementById('buy-select-all').addEventListener('change', (e) => {
        document.querySelectorAll('.buy-checkbox').forEach(cb => cb.checked = e.target.checked);
    });

    document.getElementById('refresh-buff-btn').addEventListener('click', async () => {
        alert("正在向 Buff 请求更新数据... 可能会花费一些时间，请耐心等待。");
        await apiPost('/api/buff/refresh', {});
        loadBuffItems();
    });

    document.getElementById('execute-buy-btn').addEventListener('click', async () => {
        const selected = [];
        const checkboxes = document.querySelectorAll('.buy-checkbox:checked');
        checkboxes.forEach(cb => {
            const tr = cb.closest('tr');
            const idx = cb.getAttribute('data-index');
            const qty = parseInt(tr.querySelector('.buy-qty').value);
            selected.push({ id: buffItems[idx].id, number: qty, name: buffItems[idx].name, steam_min_price: buffItems[idx].steam_min_price });
        });
        if (selected.length === 0) return alert("请勾选需要购买的饰品。");
        
        const payment = parseInt(document.getElementById('payment-method').value);
        alert(`正在发起购买，共计 ${selected.length} 种饰品...`);
        const res = await apiPost('/api/buff/buy', { items: selected, payment });
        console.log("Buy results:", res);
        alert("批量购买流程结束。详情请前往运行日志或持有饰品中查看。");
    });

    // --- Owned ---
    async function loadOwned() {
        ownedItems = await apiGet('/api/steam/owned');
        const tbody = document.getElementById('owned-items-body');
        tbody.innerHTML = ownedItems.map((item, i) => `
            <tr>
                <td><input type="checkbox" class="owned-checkbox" data-index="${i}" ${item.status==='待出售'?'':'disabled'}></td>
                <td>${item.name}</td>
                <td>¥${item.buff_price}</td>
                <td><span class="badge-pill">${item.status}</span></td>
                <td>${item.tradeUnlockTime || '-'}</td>
                <td>
                    ${item.status === '待收货' ? `<button class="button-secondary manual-receipt-btn" style="padding: 4px 10px; height: auto;" data-id="${item.goods_id}" data-time="${item.purchasedAt}">手动收货</button>` : ''}
                    <button class="button-secondary mark-self-use-btn" style="padding: 4px 10px; height: auto;" data-id="${item.goods_id}" data-asset="${item.assetid}">标记为自用</button>
                </td>
            </tr>
        `).join('');
        
        document.querySelectorAll('.mark-self-use-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const goods_id = e.target.getAttribute('data-id');
                const assetid = e.target.getAttribute('data-asset');
                await apiPost('/api/steam/owned/delete', { goods_id, assetid });
                loadOwned();
            });
        });

        document.querySelectorAll('.manual-receipt-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const assetid = prompt("请输入您在 Steam 库存中该物品的 Asset ID（可在 Steam 网页版物品详情中查看）：");
                if (assetid && assetid.trim()) {
                    const goods_id = e.target.getAttribute('data-id');
                    const purchasedAt = e.target.getAttribute('data-time');
                    await apiPost('/api/steam/owned/manual-bind', { goods_id, purchasedAt, assetid: assetid.trim() });
                    loadOwned();
                }
            });
        });
    }

    const manualAddModal = document.getElementById('manual-add-modal');
    let manualAddInventory = [];
    
    function renderManualAddList() {
        const tbody = document.getElementById('manual-add-list-body');
        const q = document.getElementById('search-manual-add-input').value.toLowerCase();
        
        let filtered = manualAddInventory;
        if (q) {
            filtered = filtered.filter(i => i.name.toLowerCase().includes(q));
        }

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">没有找到匹配的饰品</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(item => `
            <tr>
                <td><input type="checkbox" class="manual-add-checkbox" data-asset="${item.id}"></td>
                <td>${item.name}</td>
                <td><span style="color:${item.tradable?'var(--colors-success)':'var(--colors-error)'}">${item.tradable?'可交易':'不可交易'}</span></td>
                <td><input type="number" class="text-input manual-add-price" data-asset="${item.id}" placeholder="0" style="width: 100%;"></td>
            </tr>
        `).join('');
    }

    document.getElementById('search-manual-add-input').addEventListener('input', renderManualAddList);

    document.getElementById('manual-add-select-all').addEventListener('change', (e) => {
        document.querySelectorAll('.manual-add-checkbox').forEach(cb => cb.checked = e.target.checked);
    });

    document.getElementById('bulk-manual-add-btn').addEventListener('click', async () => {
        const checkboxes = document.querySelectorAll('.manual-add-checkbox:checked');
        if (checkboxes.length === 0) {
            alert('请至少选择一件饰品');
            return;
        }

        const btn = document.getElementById('bulk-manual-add-btn');
        btn.disabled = true;
        btn.textContent = '正在添加...';

        let successCount = 0;
        let failCount = 0;

        for (const cb of checkboxes) {
            const assetid = cb.getAttribute('data-asset');
            const priceInput = document.querySelector(`.manual-add-price[data-asset="${assetid}"]`);
            let buffPrice = parseFloat(priceInput.value) || 0;

            const res = await apiPost('/api/steam/owned/add-manual', { assetid, buff_price: buffPrice });
            if (res.success) successCount++;
            else failCount++;
        }

        btn.disabled = false;
        btn.textContent = '批量添加到持有';
        alert(`添加完成！成功: ${successCount}, 失败: ${failCount}`);
        manualAddModal.style.display = 'none';
        loadOwned();
    });

    document.getElementById('open-manual-add-btn').addEventListener('click', async () => {
        manualAddModal.style.display = 'flex';
        document.getElementById('search-manual-add-input').value = '';
        const tbody = document.getElementById('manual-add-list-body');
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">正在加载底层库存，请稍候...</td></tr>';
        
        manualAddInventory = await apiGet('/api/steam/inventory');
        if (!manualAddInventory || manualAddInventory.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">暂无库存数据，请先前往“Steam 库存”页面刷新。</td></tr>';
            return;
        }

        renderManualAddList();
    });

    document.getElementById('close-manual-add-modal').addEventListener('click', () => {
        manualAddModal.style.display = 'none';
    });

    document.getElementById('execute-sell-btn').addEventListener('click', async () => {
        const selected = [];
        const checkboxes = document.querySelectorAll('.owned-checkbox:checked');

        for (let cb of checkboxes) {
            const item = ownedItems[cb.getAttribute('data-index')];
            selected.push({ assetid: item.assetid, market_hash_name: item.name, auto_price: true });
        }

        if (selected.length === 0) return alert("没有勾选可售卖的物品。");
        
        alert("正在获取底层实时价格并挂单上架...请稍候！");
        const res = await apiPost('/api/steam/sell', { items: selected });
        
        if (!res.success) {
            return alert("上架请求遇到严重错误: " + res.error);
        }

        const failed = res.results.filter(r => !r.success);
        const success = res.results.filter(r => r.success);

        if (failed.length > 0) {
            alert(`挂单任务结束。\n成功: ${success.length} 件\n失败: ${failed.length} 件\n详情请查看运行日志。`);
        } else {
            alert("市场挂单请求已全部成功提交！请前往右侧【账号管理】->【待确认交易列表】中点击刷新并一键同意。");
        }
        
        loadOwned();
    });

    // --- Steam Inventory ---
    async function loadInventory() {
        const inventory = await apiGet('/api/steam/inventory');
        const grid = document.getElementById('inventory-grid');
        if (inventory.length === 0) {
            grid.innerHTML = '<p class="subtitle">库存为空或加载失败</p>';
            return;
        }
        grid.innerHTML = inventory.map(item => `
            <div class="feature-card">
                <h4 style="margin-bottom:8px;">${item.name}</h4>
                <p class="body-sm">ID: ${item.id}</p>
                <p class="body-sm">磨损: ${item.wear || '无'}</p>
                <p class="body-sm">状态: <span style="color:${item.tradable?'var(--colors-success)':'var(--colors-error)'}">${item.tradable?'可交易':'不可交易'}</span></p>
                ${item.tradeUnlockTime ? `<p class="body-sm">解锁时间: ${item.tradeUnlockTime}</p>` : ''}
            </div>
        `).join('');
    }

    document.getElementById('refresh-inventory-btn').addEventListener('click', async () => {
        alert("正在获取底层最新库存数据...");
        const res = await apiPost('/api/steam/inventory/refresh', {});
        if (res.success) {
            alert(`刷新成功！最新库存总计: ${res.count}`);
            loadInventory();
        } else {
            alert(`错误: ${res.error}`);
        }
    });

    // --- History ---
    async function loadHistory() {
        const history = await apiGet('/api/steam/history');
        const tbody = document.getElementById('history-items-body');
        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">暂无历史记录</td></tr>';
            return;
        }

        let totalSpend = 0, totalIncome = 0;
        tbody.innerHTML = history.map(item => {
            totalSpend += parseFloat(item.buff_price || 0);
            totalIncome += parseFloat(item.sell_price_no_fee || 0) / 100;
            return `
                <tr>
                    <td>${item.name}</td>
                    <td>¥${parseFloat(item.buff_price).toFixed(2)}</td>
                    <td>¥${(item.sell_price_with_fee / 100).toFixed(2)}</td>
                    <td>¥${(item.sell_price_no_fee / 100).toFixed(2)}</td>
                    <td>${item.soldAt || '未知'}</td>
                </tr>
            `;
        }).join('');

        const discount = totalIncome > 0 ? (totalSpend / totalIncome).toFixed(4) : "0.00";
        document.getElementById('history-stats').innerText = `总计支出: ¥${totalSpend.toFixed(2)} | 预计回血: ¥${totalIncome.toFixed(2)} | 平均折扣: ${discount}`;
    }

    // --- Logs ---
    let logsInterval = null;
    async function loadLogs() {
        const fetchLogs = async () => {
            const res = await apiGet('/api/logs');
            const container = document.getElementById('system-logs-container');
            container.innerText = res.logs.join('\n');
            container.scrollTop = container.scrollHeight;
        };
        fetchLogs();
        if (logsInterval) clearInterval(logsInterval);
        logsInterval = setInterval(fetchLogs, 3000);
    }

    // --- Account ---
    async function loadAccount() {
        const res = await apiGet('/api/steam/account');
        if (res.success) {
            document.getElementById('steam-2fa-code').innerText = res.authCode;
        }
        loadConfirmations();
    }
    
    async function loadConfirmations() {
        const res = await apiGet('/api/steam/confirmations');
        const ul = document.getElementById('confirmation-list');
        if (res.success && res.confirmations.length > 0) {
            ul.innerHTML = res.confirmations.map(c => `<li>${c.title} - ${c.receiving}</li>`).join('');
        } else {
            ul.innerHTML = '<li>暂无待确认操作</li>';
        }
    }
    
    document.getElementById('refresh-confirm-btn').addEventListener('click', loadConfirmations);
    document.getElementById('accept-all-btn').addEventListener('click', async () => {
        const res = await apiPost('/api/steam/confirm', {});
        if(res.success) { alert(res.message); loadConfirmations(); }
        else alert(res.error);
    });

    // --- Initial load ---
    loadOwned();
});
