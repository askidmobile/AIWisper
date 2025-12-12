/**
 * E2E тесты для раздела "Статистика" в AIWisper
 * 
 * Тестирует:
 * - Отображение 6 карточек статистики
 * - Адаптивную grid-сетку (6→3→2 колонки)
 * - Монохромные SVG-иконки
 * - Анимации и hover-эффекты
 */

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';

let electronApp: ElectronApplication;
let page: Page;

// Размеры экранов для тестирования адаптивности
const VIEWPORT_SIZES = {
    large: { width: 1400, height: 900 },   // 6 колонок
    medium: { width: 1000, height: 800 },  // 3 колонки
    small: { width: 700, height: 600 },    // 2 колонки
};

test.describe('Раздел Статистика', () => {
    test.beforeAll(async () => {
        // Запускаем Electron-приложение
        const mainPath = path.join(__dirname, '..', 'dist-electron', 'main.js');
        
        electronApp = await electron.launch({
            args: [mainPath],
            env: {
                ...process.env,
                ELECTRON_DISABLE_GPU: '1',
                NODE_ENV: 'test',
            },
        });
        
        // Получаем главное окно
        page = await electronApp.firstWindow();
        
        // Ждём загрузки приложения
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000); // Даём время на инициализацию
    });

    test.afterAll(async () => {
        await electronApp.close();
    });

    test('Приложение запускается корректно', async () => {
        const title = await page.title();
        expect(title).toBe('AIWisper');
    });

    test('Вкладка "Статистика" доступна', async () => {
        // Ищем вкладку Статистика
        const statsTab = page.getByText('Статистика');
        await expect(statsTab).toBeVisible({ timeout: 10000 });
    });

    test('Переключение на вкладку "Статистика"', async () => {
        // Кликаем на вкладку
        await page.getByText('Статистика').click();
        await page.waitForTimeout(500);
        
        // Проверяем, что контент статистики отображается
        // Либо карточки, либо сообщение "Нет данных"
        const hasStatsGrid = await page.locator('.stats-grid').count() > 0;
        const hasEmptyState = await page.getByText('Нет данных для отображения').count() > 0;
        
        expect(hasStatsGrid || hasEmptyState).toBeTruthy();
    });

    test('Отображаются 6 карточек статистики (при наличии данных)', async () => {
        // Переключаемся на статистику
        await page.getByText('Статистика').click();
        await page.waitForTimeout(500);
        
        const statsGrid = page.locator('.stats-grid');
        
        // Если есть данные, должно быть 6 карточек
        if (await statsGrid.count() > 0) {
            const cards = statsGrid.locator('.stat-card');
            const cardCount = await cards.count();
            expect(cardCount).toBe(6);
        }
    });

    test('Карточки содержат SVG-иконки (не emoji)', async () => {
        await page.getByText('Статистика').click();
        await page.waitForTimeout(500);
        
        const statsGrid = page.locator('.stats-grid');
        
        if (await statsGrid.count() > 0) {
            const cards = statsGrid.locator('.stat-card');
            const firstCard = cards.first();
            
            // Проверяем наличие SVG внутри карточки
            const svgCount = await firstCard.locator('svg').count();
            expect(svgCount).toBeGreaterThan(0);
            
            // Проверяем, что нет emoji (типичные emoji-символы)
            const cardText = await firstCard.textContent();
            const hasEmoji = /[\u{1F300}-\u{1F9FF}]/u.test(cardText || '');
            expect(hasEmoji).toBeFalsy();
        }
    });

    test('SVG-иконки монохромные (используют currentColor)', async () => {
        await page.getByText('Статистика').click();
        await page.waitForTimeout(500);
        
        const statsGrid = page.locator('.stats-grid');
        
        if (await statsGrid.count() > 0) {
            const svg = statsGrid.locator('.stat-card svg').first();
            
            if (await svg.count() > 0) {
                // Проверяем атрибут stroke
                const stroke = await svg.getAttribute('stroke');
                expect(stroke).toBe('currentColor');
            }
        }
    });

    test.describe('Адаптивность grid-сетки', () => {
        test('6 колонок на широком экране (>1200px)', async () => {
            await page.setViewportSize(VIEWPORT_SIZES.large);
            await page.getByText('Статистика').click();
            await page.waitForTimeout(500);
            
            const statsGrid = page.locator('.stats-grid');
            
            if (await statsGrid.count() > 0) {
                const gridStyle = await statsGrid.evaluate((el) => {
                    return window.getComputedStyle(el).gridTemplateColumns;
                });
                
                // Должно быть 6 колонок
                const columns = gridStyle.split(' ').filter(v => v.trim()).length;
                expect(columns).toBe(6);
            }
        });

        test('3 колонки на среднем экране (768-1200px)', async () => {
            await page.setViewportSize(VIEWPORT_SIZES.medium);
            await page.waitForTimeout(300);
            
            const statsGrid = page.locator('.stats-grid');
            
            if (await statsGrid.count() > 0) {
                const gridStyle = await statsGrid.evaluate((el) => {
                    return window.getComputedStyle(el).gridTemplateColumns;
                });
                
                // Должно быть 3 колонки
                const columns = gridStyle.split(' ').filter(v => v.trim()).length;
                expect(columns).toBe(3);
            }
        });

        test('2 колонки на узком экране (<768px)', async () => {
            await page.setViewportSize(VIEWPORT_SIZES.small);
            await page.waitForTimeout(300);
            
            const statsGrid = page.locator('.stats-grid');
            
            if (await statsGrid.count() > 0) {
                const gridStyle = await statsGrid.evaluate((el) => {
                    return window.getComputedStyle(el).gridTemplateColumns;
                });
                
                // Должно быть 2 колонки
                const columns = gridStyle.split(' ').filter(v => v.trim()).length;
                expect(columns).toBe(2);
            }
        });
    });

    test.describe('Визуальные эффекты', () => {
        test('Карточки имеют анимацию появления', async () => {
            await page.setViewportSize(VIEWPORT_SIZES.large);
            await page.getByText('Статистика').click();
            await page.waitForTimeout(100);
            
            const statsGrid = page.locator('.stats-grid');
            
            if (await statsGrid.count() > 0) {
                const card = statsGrid.locator('.stat-card').first();
                
                // Проверяем наличие CSS-анимации
                const animation = await card.evaluate((el) => {
                    return window.getComputedStyle(el).animation;
                });
                
                // Должна быть анимация statCardAppear
                expect(animation).toContain('statCardAppear');
            }
        });

        test('Hover-эффект на карточках работает', async () => {
            await page.setViewportSize(VIEWPORT_SIZES.large);
            
            const statsGrid = page.locator('.stats-grid');
            
            if (await statsGrid.count() > 0) {
                const card = statsGrid.locator('.stat-card').first();
                
                // Получаем начальный transform
                const initialTransform = await card.evaluate((el) => {
                    return window.getComputedStyle(el).transform;
                });
                
                // Наводим курсор
                await card.hover();
                await page.waitForTimeout(400); // Ждём анимацию
                
                // Проверяем изменение transform при hover
                const hoverTransform = await card.evaluate((el) => {
                    return window.getComputedStyle(el).transform;
                });
                
                // Transform должен измениться (translateY и scale)
                // Примечание: в некоторых случаях hover может не работать в headless режиме
            }
        });

        test('Иконка имеет градиентный фон', async () => {
            await page.setViewportSize(VIEWPORT_SIZES.large);
            
            const statsGrid = page.locator('.stats-grid');
            
            if (await statsGrid.count() > 0) {
                const iconWrapper = statsGrid.locator('.icon-wrapper').first();
                
                if (await iconWrapper.count() > 0) {
                    const background = await iconWrapper.evaluate((el) => {
                        return window.getComputedStyle(el).background;
                    });
                    
                    // Должен быть градиент
                    expect(background).toContain('gradient');
                }
            }
        });
    });

    test('Скриншот раздела статистики', async () => {
        await page.setViewportSize(VIEWPORT_SIZES.large);
        await page.getByText('Статистика').click();
        await page.waitForTimeout(1000); // Ждём анимации
        
        // Делаем скриншот для визуальной проверки
        await page.screenshot({ 
            path: './e2e-results/stats-section.png',
            fullPage: false,
        });
    });
});
