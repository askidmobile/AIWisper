import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';

// Настройки приложения
interface AppSettings {
    language: 'ru' | 'en' | 'auto';
    modelId: string;
    echoCancel: number;
    useVoiceIsolation: boolean;
    captureSystem: boolean;
    theme?: 'light' | 'dark';
}

interface StoreSchema {
    settings: AppSettings;
}

// Глобальные переменные - инициализируются в app.whenReady()
let store: any = null;
let isDev = true;
let mainWindow: BrowserWindow | null = null;
let goProcess: ChildProcess | null = null;
let sessionsDataDir: string = '';
let modelsDir: string = '';
let grpcAddressValue: string = '';

// Логирование
function log(message: string) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

function logError(message: string) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: 'AIWisper',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 15, y: 15 },
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.webContents.on('did-fail-load', (event: any, errorCode: any, errorDescription: any) => {
        logError(`Failed to load: ${errorDescription} (${errorCode})`);
        if (!isDev) {
            dialog.showErrorBox('Loading Error', `Failed to load application: ${errorDescription}`);
        }
    });
}

function getResourcesPath(): string {
    if (isDev) {
        return path.join(process.cwd(), '..', 'build', 'resources');
    } else {
        return process.resourcesPath;
    }
}

function getGrpcAddress(): string {
    if (process.platform === 'win32') {
        return 'npipe:\\\\.\\pipe\\aiwisper-grpc';
    }
    // Держим сокет в /tmp, чтобы адрес был стабильным и совпадал с дефолтом клиента
    const socketPath = '/tmp/aiwisper-grpc.sock';
    return `unix:${socketPath}`;
}

function startGoBackend() {
    const resourcesPath = getResourcesPath();
    const grpcAddress = getGrpcAddress();
    grpcAddressValue = grpcAddress;
    const backendPort = 18080;

    // Прокидываем адрес gRPC сокета и в дочерний backend, и в renderer (process.env)
    process.env.AIWISPER_GRPC_ADDR = grpcAddress;
    process.env.AIWISPER_HTTP_PORT = backendPort.toString();

    let backendPath: string;
    let modelPath: string;
    let dataDir: string;
    let modelsDirPath: string;
    let cwd: string;

    if (isDev) {
        const projectRoot = path.join(process.cwd(), '..');
        backendPath = path.join(projectRoot, 'backend_bin');
        modelPath = path.join(projectRoot, 'backend', 'ggml-base.bin');
        dataDir = path.join(projectRoot, 'data', 'sessions');
        modelsDirPath = path.join(projectRoot, 'data', 'models');
        cwd = projectRoot;

        if (!fs.existsSync(backendPath)) {
            backendPath = path.join(resourcesPath, 'aiwisper-backend');
        }
    } else {
        backendPath = path.join(resourcesPath, 'aiwisper-backend');
        modelPath = path.join(resourcesPath, 'ggml-base.bin');
        dataDir = path.join(app.getPath('userData'), 'sessions');
        modelsDirPath = path.join(app.getPath('userData'), 'models');
        cwd = resourcesPath;
    }

    sessionsDataDir = dataDir;
    modelsDir = modelsDirPath;

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(modelsDirPath)) {
        fs.mkdirSync(modelsDirPath, { recursive: true });
    }

    if (!fs.existsSync(backendPath)) {
        const errorMsg = `Backend binary not found: ${backendPath}`;
        logError(errorMsg);
        if (!isDev) {
            dialog.showErrorBox('Startup Error', errorMsg);
        }
        return;
    }

    if (!fs.existsSync(modelPath)) {
        log(`Default model not found: ${modelPath}, will use downloaded models`);
    }

    log(`Starting Go backend: ${backendPath}`);
    log(`Model path: ${modelPath}`);
    log(`Data directory: ${dataDir}`);
    log(`Models directory: ${modelsDirPath}`);
    log(`gRPC address: ${grpcAddress}`);
    log(`Working directory: ${cwd}`);

    const env = { ...process.env };
    if (!isDev) {
        env.DYLD_LIBRARY_PATH = resourcesPath;
        env.DYLD_FALLBACK_LIBRARY_PATH = resourcesPath;
    }

    env.AIWISPER_GRPC_ADDR = grpcAddress;

    goProcess = spawn(backendPath, ['-model', modelPath, '-data', dataDir, '-models', modelsDirPath, '-grpc-addr', grpcAddress, '-port', backendPort.toString()], {
        cwd: cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
    });

    goProcess.on('error', (err: Error) => {
        logError(`Failed to start Go backend: ${err.message}`);
        if (!isDev) {
            dialog.showErrorBox('Backend Error', `Failed to start backend: ${err.message}`);
        }
    });

    goProcess.stdout?.on('data', (data: Buffer) => {
        log(`[Backend]: ${data.toString().trim()}`);
    });

    goProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('panic')) {
            logError(`[Backend]: ${msg}`);
        } else {
            log(`[Backend]: ${msg}`);
        }
    });

    goProcess.on('close', (code: number | null) => {
        log(`Go backend exited with code ${code}`);
        goProcess = null;
    });

    goProcess.on('exit', (code: number | null, signal: string | null) => {
        if (signal) {
            log(`Go backend killed with signal ${signal}`);
        }
    });
}

function stopGoBackend() {
    if (goProcess) {
        log('Stopping Go backend...');
        goProcess.kill('SIGTERM');

        setTimeout(() => {
            if (goProcess) {
                log('Force killing Go backend...');
                goProcess.kill('SIGKILL');
                goProcess = null;
            }
        }, 3000);
    }
}

// Настройка автообновлений - вызывается после app.whenReady()
function setupAutoUpdater() {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        log('Checking for updates...');
    });

    autoUpdater.on('update-available', (info: any) => {
        log(`Update available: ${info.version}`);
    });

    autoUpdater.on('update-not-available', (info: any) => {
        log(`No updates available. Current version: ${info.version}`);
    });

    autoUpdater.on('error', (err: Error) => {
        logError(`Auto-updater error: ${err.message}`);
    });

    autoUpdater.on('download-progress', (progressObj: any) => {
        let msg = `Download speed: ${progressObj.bytesPerSecond}`;
        msg = `${msg} - Downloaded ${progressObj.percent}%`;
        msg = `${msg} (${progressObj.transferred}/${progressObj.total})`;
        log(msg);
    });

    autoUpdater.on('update-downloaded', (info: any) => {
        log(`Update downloaded: ${info.version}`);

        if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Обновление готово',
                message: `Версия ${info.version} загружена и будет установлена при следующем запуске приложения.`,
                buttons: ['Перезапустить сейчас', 'Позже']
            }).then((result) => {
                if (result.response === 0) {
                    autoUpdater.quitAndInstall();
                }
            });
        }
    });

    return autoUpdater;
}

// Главная точка входа - используем app.whenReady() для Electron
app.whenReady().then(async () => {
    // Инициализируем isDev после готовности app
    isDev = !app.isPackaged;

    // Устанавливаем имя приложения
    app.setName('AIWisper');

    // Инициализируем store (динамический import для ESM модуля)
    const { default: Store } = await import('electron-store');
    store = new Store({
        name: 'aiwisper-config',
        projectName: 'aiwisper',
        defaults: {
            settings: {
                language: 'ru',
                modelId: 'ggml-large-v3-turbo',
                echoCancel: 0.4,
                useVoiceIsolation: false,
                captureSystem: true,
                theme: 'dark'
            }
        }
    });

    log('Application ready');
    log(`Running in ${isDev ? 'development' : 'production'} mode`);
    log(`Platform: ${process.platform}, Arch: ${process.arch}`);
    log(`App path: ${app.getAppPath()}`);
    log(`Resources path: ${getResourcesPath()}`);

    startGoBackend();

    setTimeout(() => {
        createWindow();

        if (!isDev) {
            setTimeout(() => {
                log('Setting up auto-updater...');
                const autoUpdater = setupAutoUpdater();
                autoUpdater.checkForUpdatesAndNotify();
            }, 3000);
        }
    }, isDev ? 0 : 500);
});

// IPC handlers
ipcMain.handle('open-data-folder', async () => {
    if (sessionsDataDir && fs.existsSync(sessionsDataDir)) {
        log(`Opening data folder: ${sessionsDataDir}`);
        await shell.openPath(sessionsDataDir);
        return { success: true, path: sessionsDataDir };
    } else {
        logError(`Data folder not found: ${sessionsDataDir}`);
        return { success: false, error: 'Data folder not found' };
    }
});

ipcMain.handle('get-data-folder-path', () => {
    return sessionsDataDir;
});

ipcMain.handle('get-models-folder-path', () => {
    return modelsDir;
});

ipcMain.handle('save-settings', (_, settings: Partial<AppSettings>) => {
    try {
        if (!store) {
            return { success: false, error: 'Store not initialized' };
        }
        const currentSettings = store.get('settings');
        const newSettings = { ...currentSettings, ...settings };
        store.set('settings', newSettings);
        log(`Settings saved: ${JSON.stringify(newSettings)}`);
        return { success: true };
    } catch (error) {
        logError(`Failed to save settings: ${error}`);
        return { success: false, error: String(error) };
    }
});

ipcMain.handle('load-settings', () => {
    try {
        if (!store) {
            return null;
        }
        const settings = store.get('settings');
        log(`Settings loaded: ${JSON.stringify(settings)}`);
        return settings;
    } catch (error) {
        logError(`Failed to load settings: ${error}`);
        return null;
    }
});

ipcMain.handle('get-grpc-address', () => grpcAddressValue || getGrpcAddress());

app.on('window-all-closed', () => {
    log('All windows closed');
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    log('Application quitting...');
    stopGoBackend();
});

app.on('will-quit', () => {
    stopGoBackend();
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

process.on('uncaughtException', (error) => {
    logError(`Uncaught exception: ${error.message}`);
    logError(error.stack || '');
});

process.on('unhandledRejection', (reason, promise) => {
    logError(`Unhandled rejection at ${promise}: ${reason}`);
});
