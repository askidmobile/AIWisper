/**
 * Вспомогательные функции для e2e тестирования Electron-приложения AIWisper
 */

import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';

export interface LaunchOptions {
    /** Режим разработки (использует vite dev server) */
    dev?: boolean;
    /** Дополнительные аргументы для Electron */
    args?: string[];
    /** Переменные окружения */
    env?: Record<string, string>;
}

/**
 * Запускает Electron-приложение AIWisper
 */
export async function launchElectronApp(options: LaunchOptions = {}): Promise<ElectronApplication> {
    const { dev = true, args = [], env = {} } = options;
    
    // Путь к main.js (скомпилированный из main.ts)
    const mainPath = path.join(__dirname, '..', 'dist-electron', 'main.js');
    
    // Для dev режима нужно сначала запустить vite и скомпилировать electron
    const electronApp = await electron.launch({
        args: [mainPath, ...args],
        env: {
            ...process.env,
            ...env,
            // Отключаем GPU для стабильности тестов
            ELECTRON_DISABLE_GPU: '1',
            // Режим тестирования
            NODE_ENV: 'test',
        },
    });
    
    return electronApp;
}

/**
 * Ожидает загрузки главного окна приложения
 */
export async function waitForMainWindow(electronApp: ElectronApplication): Promise<Page> {
    // Ждём первое окно
    const window = await electronApp.firstWindow();
    
    // Ждём загрузки DOM
    await window.waitForLoadState('domcontentloaded');
    
    return window;
}

/**
 * Ожидает появления элемента на странице
 */
export async function waitForElement(page: Page, selector: string, timeout = 10000): Promise<void> {
    await page.waitForSelector(selector, { timeout });
}

/**
 * Делает скриншот с уникальным именем
 */
export async function takeScreenshot(page: Page, name: string): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ 
        path: `./e2e-results/screenshots/${name}-${timestamp}.png`,
        fullPage: true,
    });
}

/**
 * Проверяет, что приложение загрузилось корректно
 */
export async function verifyAppLoaded(page: Page): Promise<boolean> {
    try {
        // Ждём исчезновения экрана загрузки
        await page.waitForSelector('[data-testid="loading-screen"]', { 
            state: 'hidden',
            timeout: 30000,
        }).catch(() => {
            // Если экрана загрузки нет - это нормально
        });
        
        // Проверяем наличие основных элементов UI
        const hasHeader = await page.locator('header, [data-testid="header"]').count() > 0;
        const hasSidebar = await page.locator('[data-testid="sidebar"], .sidebar').count() > 0;
        
        return hasHeader || hasSidebar;
    } catch {
        return false;
    }
}

/**
 * Переключается на вкладку по имени
 */
export async function switchToTab(page: Page, tabName: string): Promise<void> {
    // Ищем кнопку вкладки по тексту
    const tabButton = page.getByRole('button', { name: tabName });
    
    // Если не нашли по role, пробуем по тексту
    if (await tabButton.count() === 0) {
        await page.getByText(tabName, { exact: true }).click();
    } else {
        await tabButton.click();
    }
    
    // Небольшая пауза для анимации
    await page.waitForTimeout(300);
}

/**
 * Получает количество элементов по селектору
 */
export async function getElementCount(page: Page, selector: string): Promise<number> {
    return await page.locator(selector).count();
}

/**
 * Проверяет адаптивность grid-сетки статистики
 */
export async function checkStatsGridResponsiveness(page: Page): Promise<{
    columns: number;
    cardCount: number;
}> {
    const statsGrid = page.locator('.stats-grid');
    const cards = statsGrid.locator('.stat-card');
    
    const cardCount = await cards.count();
    
    // Получаем computed style для определения количества колонок
    const gridStyle = await statsGrid.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.gridTemplateColumns;
    });
    
    // Подсчитываем колонки по количеству значений в grid-template-columns
    const columns = gridStyle.split(' ').filter(v => v.trim()).length;
    
    return { columns, cardCount };
}

/**
 * Изменяет размер окна для тестирования адаптивности
 */
export async function resizeWindow(page: Page, width: number, height: number): Promise<void> {
    await page.setViewportSize({ width, height });
    // Ждём перерисовки
    await page.waitForTimeout(100);
}
