import { defineConfig } from '@playwright/test';

/**
 * Конфигурация Playwright для e2e тестирования Electron-приложения AIWisper
 * 
 * Запуск тестов:
 *   npm run test:e2e
 * 
 * Запуск с UI:
 *   npm run test:e2e:ui
 */
export default defineConfig({
    testDir: './e2e',
    
    // Таймаут для каждого теста (30 секунд)
    timeout: 30000,
    
    // Таймаут для expect assertions
    expect: {
        timeout: 5000,
    },
    
    // Полный отчёт при CI, только ошибки локально
    reporter: process.env.CI ? 'html' : 'list',
    
    // Параллельное выполнение тестов
    fullyParallel: false, // Electron тесты лучше запускать последовательно
    
    // Количество повторов при падении
    retries: process.env.CI ? 2 : 0,
    
    // Количество воркеров
    workers: 1, // Один воркер для Electron
    
    // Глобальные настройки
    use: {
        // Скриншоты при падении
        screenshot: 'only-on-failure',
        
        // Видео при падении
        video: 'retain-on-failure',
        
        // Трейсы при первом повторе
        trace: 'on-first-retry',
    },
    
    // Папка для артефактов тестов
    outputDir: './e2e-results',
    
    // Проекты (конфигурации)
    projects: [
        {
            name: 'electron',
            testMatch: '**/*.spec.ts',
        },
    ],
});
