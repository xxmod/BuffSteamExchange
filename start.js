const { spawn } = require('child_process');

function startServer() {
    console.log('[Runner] Starting server...');
    const child = spawn('node', ['server/server.js'], { stdio: 'inherit' });

    child.on('close', (code) => {
        console.log(`[Runner] Server exited with code ${code}. Restarting in 1 second...`);
        setTimeout(startServer, 1000);
    });
}

startServer();
