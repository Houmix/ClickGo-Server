const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let localServer = null;

const PORT = 8768;
const productName = 'ClickGo Server';

function startLocalServer(webBuildPath) {
    return new Promise((resolve, reject) => {
        try {
            const srv = express();
            srv.use(express.static(webBuildPath));
            srv.get('*', (req, res) => res.sendFile(path.join(webBuildPath, 'index.html')));
            localServer = srv.listen(PORT, () => {
                console.log(`Local server started at http://localhost:${PORT}`);
                resolve(`http://localhost:${PORT}`);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        frame: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    return mainWindow;
}

async function initializeApp() {
    try {
        createWindow();

        // En production : resources/app, en dev : ../dist
        const webBuildPath = app.isPackaged
            ? path.join(process.resourcesPath, 'app')
            : path.join(__dirname, '..', 'dist');

        if (!fs.existsSync(webBuildPath)) {
            dialog.showErrorBox(
                'Build Not Found',
                'The web build folder does not exist. Please run: npm run build:web'
            );
            app.quit();
            return;
        }

        // Start the local Express server
        const serverUrl = await startLocalServer(webBuildPath);

        // Load the app from the local server
        await mainWindow.loadURL(serverUrl);

        // Show the window after it's ready
        mainWindow.show();

        // Open DevTools in development (optional, comment out for production)
        // mainWindow.webContents.openDevTools();
    } catch (error) {
        console.error('Error initializing app:', error);
        dialog.showErrorBox('Initialization Error', error.message);
        app.quit();
    }
}

app.on('ready', initializeApp);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// Setup auto-updater
autoUpdater.checkForUpdatesAndNotify();
