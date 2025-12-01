import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { autoUpdater } from 'electron-updater';

// Устанавливаем имя приложения для отображения в меню macOS
app.setName('AIWisper');

let mainWindow: BrowserWindow | null;
let goProcess: ChildProcess | null = null;

const isDev = !app.isPackaged;

// Настройка автообновлений
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

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
        titleBarStyle: 'hiddenInset', // macOS стиль с кнопками в заголовке
        trafficLightPosition: { x: 15, y: 15 },
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    // DevTools только в dev режиме
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    // В dev режиме загружаем Vite сервер, в prod - собранные файлы
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Показываем ошибки загрузки
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        logError(`Failed to load: ${errorDescription} (${errorCode})`);
        if (!isDev) {
            dialog.showErrorBox('Loading Error', `Failed to load application: ${errorDescription}`);
        }
    });
}

function getResourcesPath(): string {
    if (isDev) {
        // В dev режиме ресурсы в ../build/resources
        return path.join(process.cwd(), '..', 'build', 'resources');
    } else {
        // В prod режиме ресурсы в app.asar.unpacked или resources
        return process.resourcesPath;
    }
}

function startGoBackend() {
    const resourcesPath = getResourcesPath();
    
    let backendPath: string;
    let modelPath: string;
    let dataDir: string;
    let cwd: string;

    if (isDev) {
        // Dev: используем файлы из проекта напрямую
        const projectRoot = path.join(process.cwd(), '..');
        backendPath = path.join(projectRoot, 'backend_bin');
        modelPath = path.join(projectRoot, 'backend', 'ggml-base.bin');
        dataDir = path.join(projectRoot, 'data', 'sessions');
        cwd = projectRoot;
        
        // Fallback на build/resources если backend_bin не найден
        if (!fs.existsSync(backendPath)) {
            backendPath = path.join(resourcesPath, 'aiwisper-backend');
        }
    } else {
        // Prod: все в resources
        backendPath = path.join(resourcesPath, 'aiwisper-backend');
        modelPath = path.join(resourcesPath, 'ggml-base.bin');
        // Данные сохраняем в Application Support
        dataDir = path.join(app.getPath('userData'), 'sessions');
        cwd = resourcesPath;
    }

    // Создаём директорию для данных
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Проверяем существование файлов
    if (!fs.existsSync(backendPath)) {
        const errorMsg = `Backend binary not found: ${backendPath}`;
        logError(errorMsg);
        if (!isDev) {
            dialog.showErrorBox('Startup Error', errorMsg);
        }
        return;
    }

    if (!fs.existsSync(modelPath)) {
        const errorMsg = `Whisper model not found: ${modelPath}`;
        logError(errorMsg);
        if (!isDev) {
            dialog.showErrorBox('Startup Error', errorMsg);
        }
        return;
    }

    log(`Starting Go backend: ${backendPath}`);
    log(`Model path: ${modelPath}`);
    log(`Data directory: ${dataDir}`);
    log(`Working directory: ${cwd}`);

    // Устанавливаем переменные окружения для dylib
    const env = { ...process.env };
    if (!isDev) {
        // В prod добавляем путь к dylib
        env.DYLD_LIBRARY_PATH = resourcesPath;
        env.DYLD_FALLBACK_LIBRARY_PATH = resourcesPath;
    }

    goProcess = spawn(backendPath, ['-model', modelPath, '-data', dataDir], {
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
        // whisper.cpp логирует в stderr по умолчанию
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
        
        // Принудительное завершение через 3 секунды
        setTimeout(() => {
            if (goProcess) {
                log('Force killing Go backend...');
                goProcess.kill('SIGKILL');
                goProcess = null;
            }
        }, 3000);
    }
}

// Обработчики событий автообновления
autoUpdater.on('checking-for-update', () => {
    log('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
    log(`Update available: ${info.version}`);
});

autoUpdater.on('update-not-available', (info) => {
    log(`No updates available. Current version: ${info.version}`);
});

autoUpdater.on('error', (err) => {
    logError(`Auto-updater error: ${err.message}`);
});

autoUpdater.on('download-progress', (progressObj) => {
    let msg = `Download speed: ${progressObj.bytesPerSecond}`;
    msg = `${msg} - Downloaded ${progressObj.percent}%`;
    msg = `${msg} (${progressObj.transferred}/${progressObj.total})`;
    log(msg);
});

autoUpdater.on('update-downloaded', (info) => {
    log(`Update downloaded: ${info.version}`);
    
    // Показываем уведомление пользователю
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

app.on('ready', () => {
    log('Application ready');
    log(`Running in ${isDev ? 'development' : 'production'} mode`);
    log(`Platform: ${process.platform}, Arch: ${process.arch}`);
    log(`App path: ${app.getAppPath()}`);
    log(`Resources path: ${getResourcesPath()}`);
    
    startGoBackend();
    
    // Даём backend время на запуск
    setTimeout(() => {
        createWindow();
        
        // Проверяем обновления только в production режиме
        if (!isDev) {
            setTimeout(() => {
                log('Checking for updates...');
                autoUpdater.checkForUpdatesAndNotify();
            }, 3000);
        }
    }, isDev ? 0 : 500);
});

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

// Обработка uncaught exceptions
process.on('uncaughtException', (error) => {
    logError(`Uncaught exception: ${error.message}`);
    logError(error.stack || '');
});

process.on('unhandledRejection', (reason, promise) => {
    logError(`Unhandled rejection at ${promise}: ${reason}`);
});
