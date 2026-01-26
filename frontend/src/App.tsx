/**
 * App.tsx - точка входа приложения
 * 
 * Этот файл является обёрткой для AppWithProviders.
 * Старая монолитная версия сохранена в App.legacy.tsx
 * 
 * Для переключения на legacy UI:
 * localStorage.setItem("USE_LEGACY_UI", "true") и перезагрузите страницу
 */

export { AppWithProviders as default } from './AppWithProviders';
