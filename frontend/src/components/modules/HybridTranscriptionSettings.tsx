import React from 'react';
import { HelpTooltip } from '../common/HelpTooltip';
import { ModelState, HybridTranscriptionSettings as HybridSettings, HybridMode } from '../../types/models';

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
                    <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                        🔄 Улучшенное распознавание
                    </span>
                    <HelpTooltip title="Гибридная транскрипция" maxWidth={450}>
                        <HybridTranscriptionHelp />
                    </HelpTooltip>
                </div>

                <label
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                    }}
                >
                    <input
                        type="checkbox"
                        checked={settings.enabled}
                        onChange={(e) => handleToggle(e.target.checked)}
                        disabled={disabled}
                        style={{ accentColor: 'var(--primary)' }}
                    />
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {settings.enabled ? 'Вкл' : 'Выкл'}
                    </span>
                </label>
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
                            Режим сравнения:
                        </label>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => handleModeChange('parallel')}
                                disabled={disabled}
                                style={{
                                    flex: 1,
                                    minWidth: '100px',
                                    padding: '8px 10px',
                                    background: settings.mode === 'parallel' ? 'var(--primary)' : 'var(--glass-bg)',
                                    border: `1px solid ${settings.mode === 'parallel' ? 'var(--primary)' : 'var(--glass-border)'}`,
                                    borderRadius: '8px',
                                    color: settings.mode === 'parallel' ? 'white' : 'var(--text-primary)',
                                    fontSize: '0.75rem',
                                    cursor: disabled ? 'not-allowed' : 'pointer',
                                }}
                            >
                                ⚡ Параллельный
                            </button>
                            <button
                                onClick={() => handleModeChange('full_compare')}
                                disabled={disabled}
                                style={{
                                    flex: 1,
                                    minWidth: '100px',
                                    padding: '8px 10px',
                                    background: settings.mode === 'full_compare' ? 'var(--primary)' : 'var(--glass-bg)',
                                    border: `1px solid ${settings.mode === 'full_compare' ? 'var(--primary)' : 'var(--glass-border)'}`,
                                    borderRadius: '8px',
                                    color: settings.mode === 'full_compare' ? 'white' : 'var(--text-primary)',
                                    fontSize: '0.75rem',
                                    cursor: disabled ? 'not-allowed' : 'pointer',
                                }}
                            >
                                🔄 Полное + LLM
                            </button>
                            <button
                                onClick={() => handleModeChange('confidence')}
                                disabled={disabled}
                                style={{
                                    flex: 1,
                                    minWidth: '100px',
                                    padding: '8px 10px',
                                    background: settings.mode === 'confidence' ? 'var(--primary)' : 'var(--glass-bg)',
                                    border: `1px solid ${settings.mode === 'confidence' ? 'var(--primary)' : 'var(--glass-border)'}`,
                                    borderRadius: '8px',
                                    color: settings.mode === 'confidence' ? 'white' : 'var(--text-primary)',
                                    fontSize: '0.75rem',
                                    cursor: disabled ? 'not-allowed' : 'pointer',
                                }}
                            >
                                📊 По порогу
                            </button>
                        </div>
                        <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            {settings.mode === 'parallel' 
                                ? '⚡ Обе модели работают параллельно, анализатор выбирает лучшие слова по confidence (быстро)'
                                : settings.mode === 'full_compare' 
                                    ? '🔄 Обе модели транскрибируют весь текст, LLM выбирает лучший вариант'
                                    : '📊 Вторая модель перетранскрибирует только слова с низкой уверенностью'}
                        </p>
                    </div>

                    {/* Порог уверенности (только для режима confidence) */}
                    {settings.mode === 'confidence' && (
                        <div>
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: '6px',
                                }}
                            >
                                <label
                                    style={{
                                        fontSize: '0.8rem',
                                        color: 'var(--text-muted)',
                                    }}
                                >
                                    Порог уверенности:
                                </label>
                                <span
                                    style={{
                                        fontSize: '0.85rem',
                                        fontWeight: 500,
                                        color: 'var(--primary)',
                                    }}
                                >
                                    {Math.round(settings.confidenceThreshold * 100)}%
                                </span>
                            </div>
                            <input
                                type="range"
                                min="50"
                                max="90"
                                step="5"
                                value={settings.confidenceThreshold * 100}
                                onChange={(e) => handleThresholdChange(Number(e.target.value) / 100)}
                                disabled={disabled}
                                style={{
                                    width: '100%',
                                    accentColor: 'var(--primary)',
                                }}
                            />
                            <p
                                style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--text-muted)',
                                    marginTop: '4px',
                                }}
                            >
                                Слова с уверенностью ниже {Math.round(settings.confidenceThreshold * 100)}% будут
                                перетранскрибированы
                            </p>
                        </div>
                    )}

                    {/* Использовать LLM */}
                    <label
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={settings.useLLMForMerge}
                            onChange={(e) => handleLLMToggle(e.target.checked)}
                            disabled={disabled}
                            style={{ accentColor: 'var(--primary)' }}
                        />
                        <span style={{ fontSize: '0.85rem' }}>
                            Использовать LLM для выбора лучшего варианта
                        </span>
                        <HelpTooltip title="LLM для слияния" position="left" maxWidth={350}>
                            <p>
                                Если включено, нейросеть (Ollama) проанализирует оба варианта
                                транскрипции и выберет лучший с учётом контекста.
                            </p>
                            <p style={{ marginTop: '8px' }}>
                                Если выключено, будет использован вариант с большим показателем
                                уверенности (confidence).
                            </p>
                        </HelpTooltip>
                    </label>

                    {/* Словарь подсказок (Hotwords) */}
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                            <label
                                style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-muted)',
                                }}
                            >
                                📝 Словарь подсказок:
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
