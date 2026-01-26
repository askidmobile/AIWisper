/**
 * ProvidersSettings - Компонент настройки STT и LLM провайдеров
 *
 * Позволяет:
 * - Переключаться между локальными и облачными провайдерами
 * - Вводить API ключи (хранятся в macOS Keychain)
 * - Тестировать подключение к провайдерам
 * - Выбирать модели для каждого провайдера
 */

import React, { useState, useCallback } from 'react';
import { useProvidersContext } from '../../context/ProvidersContext';
import {
  STTProviderId,
  LLMProviderId,
  STT_PROVIDERS,
  LLM_PROVIDERS,
  OPENAI_STT_MODELS,
  DEEPGRAM_MODELS,
  GROQ_STT_MODELS,
  OPENAI_LLM_MODELS,
  OPENROUTER_POPULAR_MODELS,
  DEFAULT_OPENAI_STT_CONFIG,
  DEFAULT_DEEPGRAM_CONFIG,
  DEFAULT_GROQ_STT_CONFIG,
  DEFAULT_OPENAI_LLM_CONFIG,
  DEFAULT_OPENROUTER_CONFIG,
} from '../../types/providers';

// ============================================================================
// Styles
// ============================================================================

const sectionStyle: React.CSSProperties = {
  marginBottom: '1.5rem',
  padding: '1rem',
  background: 'var(--glass-bg)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--glass-border-subtle)',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 'var(--font-weight-semibold)' as any,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: '0.75rem',
  display: 'block',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.6rem 2.25rem 0.6rem 0.75rem',
  background: 'var(--glass-bg)',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 0.75rem center',
  backgroundSize: '12px',
  border: '1px solid var(--glass-border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  cursor: 'pointer',
  transition: 'border-color var(--duration-fast)',
  minHeight: '40px',
  lineHeight: '1.4',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  appearance: 'none',
};

const inputStyle: React.CSSProperties = {
  ...selectStyle,
  backgroundImage: 'none',
  paddingRight: '0.75rem',
  cursor: 'text',
};

const providerCardStyle: React.CSSProperties = {
  padding: '0.85rem 1rem',
  background: 'var(--glass-bg)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--glass-border)',
  marginBottom: '0.5rem',
  cursor: 'pointer',
  transition: 'all var(--duration-fast)',
};

const providerCardActiveStyle: React.CSSProperties = {
  ...providerCardStyle,
  background: 'rgba(52, 199, 89, 0.1)',
  borderColor: 'rgba(52, 199, 89, 0.3)',
};

// ============================================================================
// Helper Components
// ============================================================================

interface ProviderCardProps {
  id: string;
  name: string;
  description: string;
  isCloud: boolean;
  isActive: boolean;
  isConfigured: boolean;
  onClick: () => void;
}

const ProviderCard: React.FC<ProviderCardProps> = ({
  name,
  description,
  isCloud,
  isActive,
  isConfigured,
  onClick,
}) => {
  return (
    <div
      style={isActive ? providerCardActiveStyle : providerCardStyle}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      role="button"
      tabIndex={0}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {/* Status indicator */}
        <div
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: isActive ? '#34c759' : 'var(--text-muted)',
            flexShrink: 0,
          }}
        />

        {/* Info */}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{name}</span>
            {isCloud && (
              <span
                style={{
                  fontSize: '0.7rem',
                  padding: '0.1rem 0.4rem',
                  background: 'rgba(0, 122, 255, 0.15)',
                  color: 'var(--primary)',
                  borderRadius: '4px',
                }}
              >
                Облако
              </span>
            )}
            {isCloud && isConfigured && (
              <span
                style={{
                  fontSize: '0.7rem',
                  padding: '0.1rem 0.4rem',
                  background: 'rgba(52, 199, 89, 0.15)',
                  color: 'var(--success)',
                  borderRadius: '4px',
                }}
              >
                API ✓
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            {description}
          </div>
        </div>

        {/* Arrow */}
        {isActive && (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34c759" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
    </div>
  );
};

interface ApiKeyInputProps {
  providerId: string;
  providerType: 'stt' | 'llm';
  isSet: boolean;
  onSave: (key: string) => Promise<void>;
  onRemove: () => Promise<void>;
  onTest: () => Promise<unknown>;
  isLoading: boolean;
  testResult?: { success: boolean; error?: string; latencyMs?: number } | null;
}

const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
  isSet,
  onSave,
  onRemove,
  onTest,
  isLoading,
  testResult,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  const handleSave = async () => {
    if (apiKey.trim()) {
      await onSave(apiKey.trim());
      setApiKey('');
    }
  };

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        {isSet ? (
          <>
            <div
              style={{
                ...inputStyle,
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                cursor: 'default',
                background: 'rgba(52, 199, 89, 0.05)',
                borderColor: 'rgba(52, 199, 89, 0.2)',
              }}
            >
              <span style={{ color: 'var(--success)' }}>••••••••••••••••</span>
            </div>
            <button
              className="btn-capsule"
              onClick={onTest}
              disabled={isLoading}
              style={{
                padding: '0.5rem 0.75rem',
                fontSize: '0.85rem',
                background: 'var(--glass-bg)',
                border: '1px solid var(--glass-border)',
              }}
            >
              {isLoading ? 'Тест...' : 'Тест'}
            </button>
            <button
              className="btn-capsule"
              onClick={onRemove}
              disabled={isLoading}
              style={{
                padding: '0.5rem 0.75rem',
                fontSize: '0.85rem',
                background: 'rgba(255, 59, 48, 0.1)',
                border: '1px solid rgba(255, 59, 48, 0.2)',
                color: 'var(--danger)',
              }}
            >
              Удалить
            </button>
          </>
        ) : (
          <>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Введите API ключ..."
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              className="btn-icon"
              onClick={() => setShowKey(!showKey)}
              style={{ width: '40px', height: '40px' }}
            >
              {showKey ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
            <button
              className="btn-capsule btn-capsule-primary"
              onClick={handleSave}
              disabled={isLoading || !apiKey.trim()}
              style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
            >
              Сохранить
            </button>
          </>
        )}
      </div>

      {/* Test result */}
      {testResult && (
        <div
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem 0.75rem',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.8rem',
            background: testResult.success
              ? 'rgba(52, 199, 89, 0.1)'
              : 'rgba(255, 59, 48, 0.1)',
            color: testResult.success ? 'var(--success)' : 'var(--danger)',
          }}
        >
          {testResult.success
            ? `✓ Подключение успешно${testResult.latencyMs ? ` (${testResult.latencyMs}ms)` : ''}`
            : `✗ Ошибка: ${testResult.error || 'Неизвестная ошибка'}`}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

interface ProvidersSettingsProps {
  className?: string;
}

export const ProvidersSettings: React.FC<ProvidersSettingsProps> = ({ className }) => {
  const {
    isLoading,
    isInitialized,
    sttSettings,
    setSttSettings,
    updateSttProvider,
    llmSettings,
    setLlmSettings,
    updateLlmProvider,
    setApiKey,
    removeApiKey,
    testConnection,
    isTestingConnection,
    lastTestResult,
    error,
  } = useProvidersContext();

  // Tab state
  const [activeTab, setActiveTab] = useState<'stt' | 'llm'>('stt');

  // Expanded provider for configuration
  const [expandedSTT, setExpandedSTT] = useState<STTProviderId | null>(null);
  const [expandedLLM, setExpandedLLM] = useState<LLMProviderId | null>(null);

  // Handlers
  const handleSTTProviderClick = useCallback(
    async (id: STTProviderId) => {
      if (sttSettings.activeProvider === id) {
        // Toggle expansion
        setExpandedSTT(expandedSTT === id ? null : id);
      } else {
        // Switch active provider
        await updateSttProvider(id);
        setExpandedSTT(id);
      }
    },
    [sttSettings, expandedSTT, updateSttProvider]
  );

  const handleLLMProviderClick = useCallback(
    async (id: LLMProviderId) => {
      if (llmSettings.activeProvider === id) {
        setExpandedLLM(expandedLLM === id ? null : id);
      } else {
        await updateLlmProvider(id);
        setExpandedLLM(id);
      }
    },
    [llmSettings, expandedLLM, updateLlmProvider]
  );

  const handleSetSTTApiKey = useCallback(
    async (providerId: STTProviderId, apiKey: string) => {
      await setApiKey('stt', providerId, apiKey);
      
      // Update config to mark key as set
      const newSettings = { ...sttSettings };
      switch (providerId) {
        case 'openai':
          newSettings.openai = { ...(newSettings.openai || DEFAULT_OPENAI_STT_CONFIG), enabled: true, apiKeySet: true };
          break;
        case 'deepgram':
          newSettings.deepgram = { ...(newSettings.deepgram || DEFAULT_DEEPGRAM_CONFIG), enabled: true, apiKeySet: true };
          break;
        case 'groq':
          newSettings.groq = { ...(newSettings.groq || DEFAULT_GROQ_STT_CONFIG), enabled: true, apiKeySet: true };
          break;
      }
      await setSttSettings(newSettings);
    },
    [sttSettings, setApiKey, setSttSettings]
  );

  const handleRemoveSTTApiKey = useCallback(
    async (providerId: STTProviderId) => {
      await removeApiKey('stt', providerId);
      
      const newSettings = { ...sttSettings };
      switch (providerId) {
        case 'openai':
          if (newSettings.openai) newSettings.openai.apiKeySet = false;
          break;
        case 'deepgram':
          if (newSettings.deepgram) newSettings.deepgram.apiKeySet = false;
          break;
        case 'groq':
          if (newSettings.groq) newSettings.groq.apiKeySet = false;
          break;
      }
      await setSttSettings(newSettings);
    },
    [sttSettings, removeApiKey, setSttSettings]
  );

  const handleSetLLMApiKey = useCallback(
    async (providerId: LLMProviderId, apiKey: string) => {
      await setApiKey('llm', providerId, apiKey);
      
      const newSettings = { ...llmSettings };
      switch (providerId) {
        case 'openai':
          newSettings.openai = { ...(newSettings.openai || DEFAULT_OPENAI_LLM_CONFIG), enabled: true, apiKeySet: true };
          break;
        case 'openrouter':
          newSettings.openrouter = { ...(newSettings.openrouter || DEFAULT_OPENROUTER_CONFIG), enabled: true, apiKeySet: true };
          break;
      }
      await setLlmSettings(newSettings);
    },
    [llmSettings, setApiKey, setLlmSettings]
  );

  const handleRemoveLLMApiKey = useCallback(
    async (providerId: LLMProviderId) => {
      await removeApiKey('llm', providerId);
      
      const newSettings = { ...llmSettings };
      switch (providerId) {
        case 'openai':
          if (newSettings.openai) newSettings.openai.apiKeySet = false;
          break;
        case 'openrouter':
          if (newSettings.openrouter) newSettings.openrouter.apiKeySet = false;
          break;
      }
      await setLlmSettings(newSettings);
    },
    [llmSettings, removeApiKey, setLlmSettings]
  );

  if (!isInitialized) {
    return (
      <div className={className} style={sectionStyle}>
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
          Загрузка провайдеров...
        </div>
      </div>
    );
  }

  // Get config status
  const getSTTConfigured = (id: STTProviderId): boolean => {
    switch (id) {
      case 'local':
        return true;
      case 'openai':
        return sttSettings.openai?.apiKeySet || false;
      case 'deepgram':
        return sttSettings.deepgram?.apiKeySet || false;
      case 'groq':
        return sttSettings.groq?.apiKeySet || false;
      default:
        return false;
    }
  };

  const getLLMConfigured = (id: LLMProviderId): boolean => {
    switch (id) {
      case 'ollama':
        return true;
      case 'openai':
        return llmSettings.openai?.apiKeySet || false;
      case 'openrouter':
        return llmSettings.openrouter?.apiKeySet || false;
      default:
        return false;
    }
  };

  return (
    <div className={className}>
      {/* Error message */}
      {error && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(255, 59, 48, 0.1)',
            border: '1px solid rgba(255, 59, 48, 0.2)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--danger)',
            fontSize: '0.85rem',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1rem',
          padding: '0.25rem',
          background: 'var(--glass-bg)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <button
          onClick={() => setActiveTab('stt')}
          style={{
            flex: 1,
            padding: '0.6rem 1rem',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            background: activeTab === 'stt' ? 'var(--glass-bg-elevated)' : 'transparent',
            color: activeTab === 'stt' ? 'var(--text-primary)' : 'var(--text-muted)',
            fontWeight: activeTab === 'stt' ? 600 : 400,
            cursor: 'pointer',
            transition: 'all var(--duration-fast)',
          }}
        >
          Транскрибация (STT)
        </button>
        <button
          onClick={() => setActiveTab('llm')}
          style={{
            flex: 1,
            padding: '0.6rem 1rem',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            background: activeTab === 'llm' ? 'var(--glass-bg-elevated)' : 'transparent',
            color: activeTab === 'llm' ? 'var(--text-primary)' : 'var(--text-muted)',
            fontWeight: activeTab === 'llm' ? 600 : 400,
            cursor: 'pointer',
            transition: 'all var(--duration-fast)',
          }}
        >
          LLM (Сводка)
        </button>
      </div>

      {/* STT Providers */}
      {activeTab === 'stt' && (
        <div>
          <span style={labelStyle}>Провайдеры транскрибации</span>

          {/* Provider list */}
          {(Object.keys(STT_PROVIDERS) as STTProviderId[])
            .filter((id) => id !== 'assemblyai') // Пока не реализован
            .map((id) => {
              const meta = STT_PROVIDERS[id];
              const isActive = sttSettings.activeProvider === id;
              const isExpanded = expandedSTT === id;
              const isConfigured = getSTTConfigured(id);

              return (
                <div key={id}>
                  <ProviderCard
                    id={id}
                    name={meta.name}
                    description={meta.description}
                    isCloud={meta.isCloud}
                    isActive={isActive}
                    isConfigured={isConfigured}
                    onClick={() => handleSTTProviderClick(id)}
                  />

                  {/* Expanded configuration */}
                  {isActive && isExpanded && meta.requiresApiKey && (
                    <div
                      style={{
                        marginTop: '-0.25rem',
                        marginBottom: '0.5rem',
                        padding: '1rem',
                        background: 'var(--glass-bg)',
                        borderRadius: '0 0 var(--radius-md) var(--radius-md)',
                        borderTop: 'none',
                      }}
                    >
                      <label
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--text-secondary)',
                          display: 'block',
                          marginBottom: '0.25rem',
                        }}
                      >
                        API ключ
                      </label>
                      <ApiKeyInput
                        providerId={id}
                        providerType="stt"
                        isSet={isConfigured}
                        onSave={(key) => handleSetSTTApiKey(id, key)}
                        onRemove={() => handleRemoveSTTApiKey(id)}
                        onTest={() => testConnection('stt', id)}
                        isLoading={isLoading || isTestingConnection}
                        testResult={lastTestResult}
                      />

                      {/* Model selector */}
                      {isConfigured && (
                        <div style={{ marginTop: '1rem' }}>
                          <label
                            style={{
                              fontSize: '0.8rem',
                              color: 'var(--text-secondary)',
                              display: 'block',
                              marginBottom: '0.35rem',
                            }}
                          >
                            Модель
                          </label>
                          <select
                            value={
                              id === 'openai'
                                ? sttSettings.openai?.model
                                : id === 'deepgram'
                                  ? sttSettings.deepgram?.model
                                  : sttSettings.groq?.model
                            }
                            onChange={async (e) => {
                              const newSettings = { ...sttSettings };
                              if (id === 'openai' && newSettings.openai) {
                                newSettings.openai.model = e.target.value;
                              } else if (id === 'deepgram' && newSettings.deepgram) {
                                newSettings.deepgram.model = e.target.value;
                              } else if (id === 'groq' && newSettings.groq) {
                                newSettings.groq.model = e.target.value;
                              }
                              await setSttSettings(newSettings);
                            }}
                            style={selectStyle}
                          >
                            {(id === 'openai'
                              ? OPENAI_STT_MODELS
                              : id === 'deepgram'
                                ? DEEPGRAM_MODELS
                                : GROQ_STT_MODELS
                            ).map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Docs link */}
                      {meta.docsUrl && (
                        <a
                          href={meta.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: 'inline-block',
                            marginTop: '0.75rem',
                            fontSize: '0.8rem',
                            color: 'var(--primary)',
                          }}
                        >
                          Документация →
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {/* LLM Providers */}
      {activeTab === 'llm' && (
        <div>
          <span style={labelStyle}>LLM провайдеры</span>

          {(Object.keys(LLM_PROVIDERS) as LLMProviderId[]).map((id) => {
            const meta = LLM_PROVIDERS[id];
            const isActive = llmSettings.activeProvider === id;
            const isExpanded = expandedLLM === id;
            const isConfigured = getLLMConfigured(id);

            return (
              <div key={id}>
                <ProviderCard
                  id={id}
                  name={meta.name}
                  description={meta.description}
                  isCloud={meta.isCloud}
                  isActive={isActive}
                  isConfigured={isConfigured}
                  onClick={() => handleLLMProviderClick(id)}
                />

                {/* Expanded configuration */}
                {isActive && isExpanded && (
                  <div
                    style={{
                      marginTop: '-0.25rem',
                      marginBottom: '0.5rem',
                      padding: '1rem',
                      background: 'var(--glass-bg)',
                      borderRadius: '0 0 var(--radius-md) var(--radius-md)',
                      borderTop: 'none',
                    }}
                  >
                    {/* Ollama specific config */}
                    {id === 'ollama' && (
                      <>
                        <label
                          style={{
                            fontSize: '0.8rem',
                            color: 'var(--text-secondary)',
                            display: 'block',
                            marginBottom: '0.35rem',
                          }}
                        >
                          URL сервера
                        </label>
                        <input
                          type="text"
                          value={llmSettings.ollama.url}
                          onChange={async (e) => {
                            const newSettings = {
                              ...llmSettings,
                              ollama: { ...llmSettings.ollama, url: e.target.value },
                            };
                            await setLlmSettings(newSettings);
                          }}
                          placeholder="http://localhost:11434"
                          style={inputStyle}
                        />
                        <div style={{ marginTop: '0.5rem' }}>
                          <button
                            className="btn-capsule"
                            onClick={() => testConnection('llm', 'ollama')}
                            disabled={isLoading || isTestingConnection}
                            style={{
                              padding: '0.4rem 0.75rem',
                              fontSize: '0.8rem',
                              background: 'var(--glass-bg)',
                              border: '1px solid var(--glass-border)',
                            }}
                          >
                            {isTestingConnection ? 'Проверка...' : 'Проверить подключение'}
                          </button>
                          {lastTestResult && (
                            <span
                              style={{
                                marginLeft: '0.75rem',
                                fontSize: '0.8rem',
                                color: lastTestResult.success ? 'var(--success)' : 'var(--danger)',
                              }}
                            >
                              {lastTestResult.success ? '✓ Подключено' : `✗ ${lastTestResult.error}`}
                            </span>
                          )}
                        </div>
                      </>
                    )}

                    {/* Cloud provider API key */}
                    {meta.requiresApiKey && (
                      <>
                        <label
                          style={{
                            fontSize: '0.8rem',
                            color: 'var(--text-secondary)',
                            display: 'block',
                            marginBottom: '0.25rem',
                          }}
                        >
                          API ключ
                        </label>
                        <ApiKeyInput
                          providerId={id}
                          providerType="llm"
                          isSet={isConfigured}
                          onSave={(key) => handleSetLLMApiKey(id, key)}
                          onRemove={() => handleRemoveLLMApiKey(id)}
                          onTest={() => testConnection('llm', id)}
                          isLoading={isLoading || isTestingConnection}
                          testResult={lastTestResult}
                        />
                      </>
                    )}

                    {/* Model selector */}
                    {(id !== 'ollama' && isConfigured) && (
                      <div style={{ marginTop: '1rem' }}>
                        <label
                          style={{
                            fontSize: '0.8rem',
                            color: 'var(--text-secondary)',
                            display: 'block',
                            marginBottom: '0.35rem',
                          }}
                        >
                          Модель
                        </label>
                        <select
                          value={
                            id === 'openai'
                              ? llmSettings.openai?.model
                              : llmSettings.openrouter?.model
                          }
                          onChange={async (e) => {
                            const newSettings = { ...llmSettings };
                            if (id === 'openai' && newSettings.openai) {
                              newSettings.openai.model = e.target.value;
                            } else if (id === 'openrouter' && newSettings.openrouter) {
                              newSettings.openrouter.model = e.target.value;
                            }
                            await setLlmSettings(newSettings);
                          }}
                          style={selectStyle}
                        >
                          {(id === 'openai' ? OPENAI_LLM_MODELS : OPENROUTER_POPULAR_MODELS).map(
                            (m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            )
                          )}
                        </select>
                      </div>
                    )}

                    {/* Docs link */}
                    {meta.docsUrl && (
                      <a
                        href={meta.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: 'inline-block',
                          marginTop: '0.75rem',
                          fontSize: '0.8rem',
                          color: 'var(--primary)',
                        }}
                      >
                        Документация →
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ProvidersSettings;
