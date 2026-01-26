import React from 'react';
import { HelpTooltip, Switch, Slider } from '../common';
import { ModelState, HybridTranscriptionSettings as HybridSettings, HybridMode } from '../../types/models';

// SVG Icons for mode buttons
const ParallelIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
    </svg>
);

// CompareIcon was used for full_compare mode which is now deprecated
// const CompareIcon = () => (
//     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
//         <path d="M23 4v6h-6M1 20v-6h6" />
//         <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
//     </svg>
// );

const ConfidenceIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
);

interface HybridTranscriptionSettingsProps {
    settings: HybridSettings;
    onChange: (settings: HybridSettings) => void;
    availableModels: ModelState[];
    currentModelId: string;
    disabled?: boolean;
}

/**
 * Компонент настроек гибридной транскрипции
 * Позволяет включить двухпроходное распознавание с использованием двух моделей
 */
export const HybridTranscriptionSettingsPanel: React.FC<HybridTranscriptionSettingsProps> = ({
    settings,
    onChange,
    availableModels,
    currentModelId,
    disabled = false,
}) => {
    // Фильтруем модели для выбора дополнительной (исключаем текущую)
    const secondaryModels = availableModels.filter(
        (m) =>
            m.status === 'downloaded' &&
            m.id !== currentModelId &&
            (m.engine === 'whisper' || m.engine === 'gigaam' || m.engine === 'fluid-asr')
    );

    const handleToggle = (enabled: boolean) => {
        onChange({ ...settings, enabled });
    };

    const handleSecondaryModelChange = (secondaryModelId: string) => {
        onChange({ ...settings, secondaryModelId });
    };

    const handleThresholdChange = (confidenceThreshold: number) => {
        onChange({ ...settings, confidenceThreshold });
    };

    const handleLLMToggle = (useLLMForMerge: boolean) => {
        onChange({ ...settings, useLLMForMerge });
    };
    
    const handleModeChange = (mode: HybridMode) => {
        onChange({ ...settings, mode });
    };

    const handleHotwordsChange = (text: string) => {
        // Парсим строку в массив, убираем пустые и дубликаты
        const words = text
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i);
        onChange({ ...settings, hotwords: words.length > 0 ? words : undefined });
    };

    return (
        <div
            style={{
                padding: '12px 16px',
                background: 'var(--surface-strong)',
                borderRadius: '12px',
                border: '1px solid var(--border)',
            }}
        >
            {/* Заголовок с переключателем */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: settings.enabled ? '16px' : 0,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.7 }}>
                        <path d="M23 4v6h-6M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                        Улучшенное распознавание
                    </span>
                    <HelpTooltip title="Гибридная транскрипция" maxWidth={520}>
                        <HybridTranscriptionHelp />
                    </HelpTooltip>
                </div>

                <Switch
                    checked={settings.enabled}
                    onChange={handleToggle}
                    disabled={disabled}
                    size="sm"
                />
            </div>

            {/* Настройки (показываются только если включено) */}
            {settings.enabled && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {/* Выбор дополнительной модели */}
                    <div>
                        <label
                            style={{
                                display: 'block',
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                                marginBottom: '6px',
                            }}
                        >
                            Дополнительная модель для проблемных участков:
                        </label>
                        <select
                            value={settings.secondaryModelId}
                            onChange={(e) => handleSecondaryModelChange(e.target.value)}
                            disabled={disabled}
                            style={{
                                width: '100%',
                                padding: '8px 12px',
                                background: 'var(--glass-bg)',
                                border: '1px solid var(--glass-border)',
                                borderRadius: '8px',
                                color: 'var(--text-primary)',
                                fontSize: '0.85rem',
                                cursor: disabled ? 'not-allowed' : 'pointer',
                            }}
                        >
                            <option value="">Выберите модель...</option>
                            {secondaryModels.map((model) => (
                                <option key={model.id} value={model.id}>
                                    {model.name} {model.wer && `(WER: ${model.wer})`}
                                </option>
                            ))}
                        </select>
                        {secondaryModels.length === 0 && (
                            <p
                                style={{
                                    fontSize: '0.75rem',
                                    color: 'var(--warning)',
                                    marginTop: '4px',
                                }}
                            >
                                Скачайте дополнительную модель в менеджере моделей
                            </p>
                        )}
                    </div>

                    {/* Режим работы */}
                    <div>
                        <label
                            style={{
                                display: 'block',
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                                marginBottom: '6px',
                            }}
                        >
                            Режим слияния:
                        </label>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => handleModeChange('parallel')}
                                disabled={disabled}
                                style={{
                                    flex: 1,
                                    minWidth: '140px',
                                    padding: '8px 10px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '6px',
                                    background: settings.mode === 'parallel' ? 'var(--primary)' : 'var(--glass-bg)',
                                    border: `1px solid ${settings.mode === 'parallel' ? 'var(--primary)' : 'var(--glass-border)'}`,
                                    borderRadius: '8px',
                                    color: settings.mode === 'parallel' ? 'white' : 'var(--text-primary)',
                                    fontSize: '0.75rem',
                                    cursor: disabled ? 'not-allowed' : 'pointer',
                                    transition: 'all 0.15s ease',
                                }}
                            >
                                <ParallelIcon />
                                Пословное слияние
                            </button>
                            <button
                                onClick={() => handleModeChange('confidence')}
                                disabled={disabled}
                                style={{
                                    flex: 1,
                                    minWidth: '140px',
                                    padding: '8px 10px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '6px',
                                    background: settings.mode === 'confidence' ? 'var(--primary)' : 'var(--glass-bg)',
                                    border: `1px solid ${settings.mode === 'confidence' ? 'var(--primary)' : 'var(--glass-border)'}`,
                                    borderRadius: '8px',
                                    color: settings.mode === 'confidence' ? 'white' : 'var(--text-primary)',
                                    fontSize: '0.75rem',
                                    cursor: disabled ? 'not-allowed' : 'pointer',
                                    transition: 'all 0.15s ease',
                                }}
                            >
                                <ConfidenceIcon />
                                По порогу confidence
                            </button>
                        </div>
                        <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            {settings.mode === 'parallel' 
                                ? 'Обе модели транскрибируют весь текст, система выбирает лучшие слова через voting (быстро)'
                                : 'Вторая модель перетранскрибирует только слова с низким confidence'}
                        </p>
                    </div>

                    {/* Порог уверенности (только для режима confidence) */}
                    {settings.mode === 'confidence' && (
                        <div>
                            <Slider
                                value={settings.confidenceThreshold}
                                onChange={handleThresholdChange}
                                min={0.5}
                                max={0.9}
                                step={0.05}
                                label="Порог уверенности"
                                description={`Слова с уверенностью ниже ${Math.round(settings.confidenceThreshold * 100)}% будут перетранскрибированы`}
                                valueFormat={(v) => `${Math.round(v * 100)}%`}
                                disabled={disabled}
                            />
                        </div>
                    )}

                    {/* Использовать LLM */}
                    <div style={{ 
                        padding: '10px 12px',
                        background: settings.useLLMForMerge ? 'rgba(var(--primary-rgb), 0.1)' : 'var(--glass-bg)',
                        border: `1px solid ${settings.useLLMForMerge ? 'var(--primary)' : 'var(--glass-border)'}`,
                        borderRadius: '8px',
                        transition: 'all 0.15s ease',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.7, flexShrink: 0 }}>
                                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
                                    <circle cx="7.5" cy="14.5" r="1.5" />
                                    <circle cx="16.5" cy="14.5" r="1.5" />
                                </svg>
                                <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>
                                    Улучшить через LLM (Ollama)
                                </span>
                                <HelpTooltip title="LLM для улучшения" position="left" maxWidth={380}>
                                    <p>
                                        После слияния результатов двух моделей, LLM (Ollama) проанализирует 
                                        текст и исправит грамматические ошибки, пунктуацию и выберет 
                                        правильные варианты спорных слов с учётом контекста.
                                    </p>
                                    <p style={{ marginTop: '8px' }}>
                                        <strong>Требования:</strong> Запущенный Ollama с выбранной моделью.
                                    </p>
                                    <p style={{ marginTop: '8px' }}>
                                        <strong>Рекомендуемые модели:</strong> gemma2, llama3.2, qwen2.5
                                    </p>
                                </HelpTooltip>
                            </div>
                            <Switch
                                checked={settings.useLLMForMerge}
                                onChange={handleLLMToggle}
                                disabled={disabled}
                                size="sm"
                            />
                        </div>
                        {settings.useLLMForMerge && (
                            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '6px', marginLeft: '24px' }}>
                                LLM будет вызван после слияния для финальной корректировки текста
                            </p>
                        )}
                    </div>

                    {/* Словарь подсказок (Hotwords) */}
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.6 }}>
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                                <line x1="16" y1="13" x2="8" y2="13" />
                                <line x1="16" y1="17" x2="8" y2="17" />
                            </svg>
                            <label
                                style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-muted)',
                                }}
                            >
                                Словарь подсказок:
                            </label>
                            <HelpTooltip title="Словарь подсказок (Hotwords)" position="left" maxWidth={400}>
                                <p>
                                    Введите термины, имена и аббревиатуры, которые модели часто распознают неправильно.
                                </p>
                                <p style={{ marginTop: '8px' }}>
                                    <strong>Примеры:</strong> Notifier, API, B2C, Люха, техкомитет
                                </p>
                                <p style={{ marginTop: '8px' }}>
                                    Система найдёт похожие слова в транскрипции (по расстоянию Левенштейна) 
                                    и заменит их на правильное написание из словаря.
                                </p>
                            </HelpTooltip>
                        </div>
                        <textarea
                            placeholder="Notifier, API, B2C, Люха, техкомитет..."
                            value={settings.hotwords?.join(', ') || ''}
                            onChange={(e) => handleHotwordsChange(e.target.value)}
                            disabled={disabled}
                            rows={2}
                            style={{
                                width: '100%',
                                padding: '8px 12px',
                                background: 'var(--glass-bg)',
                                border: '1px solid var(--glass-border)',
                                borderRadius: '8px',
                                color: 'var(--text-primary)',
                                fontSize: '0.85rem',
                                resize: 'vertical',
                                minHeight: '50px',
                                fontFamily: 'inherit',
                            }}
                        />
                        <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            Через запятую. Слова с похожим звучанием будут заменены на указанные.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * Содержимое справки по гибридной транскрипции
 */
const HybridTranscriptionHelp: React.FC = () => (
    <div>
        <p style={{ marginBottom: '12px' }}>
            Эта функция комбинирует сильные стороны двух моделей распознавания речи.
        </p>

        <h4 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px', color: 'var(--text-primary)' }}>
            Как это работает:
        </h4>
        <ol style={{ paddingLeft: '20px', marginBottom: '12px' }}>
            <li style={{ marginBottom: '4px' }}>
                <strong>Первый проход</strong> — основная модель транскрибирует весь аудиофайл
            </li>
            <li style={{ marginBottom: '4px' }}>
                <strong>Анализ уверенности</strong> — система находит слова с низким confidence
            </li>
            <li style={{ marginBottom: '4px' }}>
                <strong>Второй проход</strong> — дополнительная модель перетранскрибирует проблемные участки
            </li>
            <li>
                <strong>Объединение</strong> — LLM выбирает лучший вариант
            </li>
        </ol>

        <h4 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px', color: 'var(--text-primary)' }}>
            Когда использовать:
        </h4>
        <ul style={{ paddingLeft: '20px', marginBottom: '12px' }}>
            <li style={{ marginBottom: '4px' }}>Много иностранных терминов (API, B2C, UMS)</li>
            <li style={{ marginBottom: '4px' }}>Основная модель хороша с языком, но плоха с терминологией</li>
            <li>Важна максимальная точность</li>
        </ul>

        <h4 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px', color: 'var(--text-primary)' }}>
            Рекомендуемые комбинации:
        </h4>
        <ul style={{ paddingLeft: '20px' }}>
            <li style={{ marginBottom: '4px' }}>
                <strong>GigaAM</strong> + <strong>Whisper</strong> — для русского с англ. терминами
            </li>
            <li>
                <strong>Parakeet</strong> + <strong>Whisper Large</strong> — для английского с редкими терминами
            </li>
        </ul>
    </div>
);

export default HybridTranscriptionSettingsPanel;
