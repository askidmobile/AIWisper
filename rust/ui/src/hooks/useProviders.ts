/**
 * Hook для управления STT и LLM провайдерами
 * 
 * Предоставляет методы для:
 * - Получения/сохранения настроек провайдеров
 * - Управления API ключами (через macOS Keychain)
 * - Тестирования подключения к провайдерам
 * - Получения статуса провайдеров
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  STTProvidersSettings,
  LLMProvidersSettings,
  STTProviderId,
  LLMProviderId,
  ProviderStatus,
  ConnectionTestResult,
  DEFAULT_LOCAL_STT_CONFIG,
  DEFAULT_OLLAMA_CONFIG,
} from '../types/providers';

// Check if running in Tauri
const isTauri = () => '__TAURI__' in window;

// Tauri invoke (lazy import)
let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
if (typeof window !== 'undefined' && isTauri()) {
  import('@tauri-apps/api/core').then(module => {
    tauriInvoke = module.invoke;
  });
}

// ============================================================================
// Types
// ============================================================================

export interface ProvidersStatusResponse {
  stt: ProviderStatus[];
  llm: ProviderStatus[];
}

export interface UseProvidersReturn {
  // Loading states
  isLoading: boolean;
  isInitialized: boolean;
  
  // STT Settings
  sttSettings: STTProvidersSettings;
  setSttSettings: (settings: STTProvidersSettings) => Promise<void>;
  updateSttProvider: (providerId: STTProviderId) => Promise<void>;
  
  // LLM Settings
  llmSettings: LLMProvidersSettings;
  setLlmSettings: (settings: LLMProvidersSettings) => Promise<void>;
  updateLlmProvider: (providerId: LLMProviderId) => Promise<void>;
  
  // API Keys
  setApiKey: (type: 'stt' | 'llm', providerId: string, apiKey: string) => Promise<void>;
  removeApiKey: (type: 'stt' | 'llm', providerId: string) => Promise<void>;
  hasApiKey: (type: 'stt' | 'llm', providerId: string) => Promise<boolean>;
  
  // Connection Testing
  testConnection: (type: 'stt' | 'llm', providerId: string) => Promise<ConnectionTestResult>;
  isTestingConnection: boolean;
  lastTestResult: ConnectionTestResult | null;
  
  // Provider Status
  providersStatus: ProvidersStatusResponse | null;
  refreshStatus: () => Promise<void>;
  
  // Errors
  error: string | null;
  clearError: () => void;
}

// ============================================================================
// Default Settings
// ============================================================================

const defaultSttSettings: STTProvidersSettings = {
  activeProvider: 'local',
  local: DEFAULT_LOCAL_STT_CONFIG,
};

const defaultLlmSettings: LLMProvidersSettings = {
  activeProvider: 'ollama',
  ollama: DEFAULT_OLLAMA_CONFIG,
};

// ============================================================================
// Hook Implementation
// ============================================================================

export function useProviders(): UseProvidersReturn {
  // State
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [sttSettings, setSttSettingsState] = useState<STTProvidersSettings>(defaultSttSettings);
  const [llmSettings, setLlmSettingsState] = useState<LLMProvidersSettings>(defaultLlmSettings);
  const [providersStatus, setProvidersStatus] = useState<ProvidersStatusResponse | null>(null);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [lastTestResult, setLastTestResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Ref to track initialization
  const initRef = useRef(false);

  // Wait for Tauri invoke to be ready
  const waitForTauri = async (): Promise<boolean> => {
    if (!isTauri()) return false;
    
    const maxWait = 50; // 5 seconds
    let waited = 0;
    while (!tauriInvoke && waited < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waited++;
    }
    return !!tauriInvoke;
  };

  // ============================================================================
  // Load Settings on Mount
  // ============================================================================
  
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    
    const loadSettings = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        const tauriReady = await waitForTauri();
        if (!tauriReady || !tauriInvoke) {
          console.warn('[useProviders] Tauri not available, using defaults');
          setIsInitialized(true);
          setIsLoading(false);
          return;
        }
        
        // Load STT settings
        try {
          const stt = await tauriInvoke('get_stt_providers_settings') as STTProvidersSettings;
          if (stt) {
            setSttSettingsState(stt);
          }
        } catch (e) {
          console.error('[useProviders] Failed to load STT settings:', e);
        }
        
        // Load LLM settings
        try {
          const llm = await tauriInvoke('get_llm_providers_settings') as LLMProvidersSettings;
          if (llm) {
            setLlmSettingsState(llm);
          }
        } catch (e) {
          console.error('[useProviders] Failed to load LLM settings:', e);
        }
        
        // Load providers status
        try {
          const status = await tauriInvoke('get_providers_status') as ProvidersStatusResponse;
          if (status) {
            setProvidersStatus(status);
          }
        } catch (e) {
          console.error('[useProviders] Failed to load providers status:', e);
        }
        
        setIsInitialized(true);
      } catch (e) {
        console.error('[useProviders] Initialization failed:', e);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    };
    
    loadSettings();
  }, []);

  // ============================================================================
  // STT Settings
  // ============================================================================
  
  const setSttSettings = useCallback(async (settings: STTProvidersSettings) => {
    setIsLoading(true);
    setError(null);
    
    try {
      if (tauriInvoke) {
        await tauriInvoke('set_stt_providers_settings', { settings });
      }
      setSttSettingsState(settings);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const updateSttProvider = useCallback(async (providerId: STTProviderId) => {
    const newSettings = { ...sttSettings, activeProvider: providerId };
    await setSttSettings(newSettings);
  }, [sttSettings, setSttSettings]);

  // ============================================================================
  // LLM Settings
  // ============================================================================
  
  const setLlmSettings = useCallback(async (settings: LLMProvidersSettings) => {
    setIsLoading(true);
    setError(null);
    
    try {
      if (tauriInvoke) {
        await tauriInvoke('set_llm_providers_settings', { settings });
      }
      setLlmSettingsState(settings);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const updateLlmProvider = useCallback(async (providerId: LLMProviderId) => {
    const newSettings = { ...llmSettings, activeProvider: providerId };
    await setLlmSettings(newSettings);
  }, [llmSettings, setLlmSettings]);

  // ============================================================================
  // API Key Management
  // ============================================================================
  
  const setApiKey = useCallback(async (
    type: 'stt' | 'llm',
    providerId: string,
    apiKey: string
  ) => {
    setIsLoading(true);
    setError(null);
    
    try {
      if (tauriInvoke) {
        await tauriInvoke('set_provider_api_key', {
          request: {
            providerType: type,
            providerId,
            apiKey,
          },
        });
      }
      
      // Refresh status after setting key
      await refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const removeApiKey = useCallback(async (type: 'stt' | 'llm', providerId: string) => {
    setIsLoading(true);
    setError(null);
    
    try {
      if (tauriInvoke) {
        await tauriInvoke('remove_provider_api_key', {
          request: {
            providerType: type,
            providerId,
          },
        });
      }
      
      // Refresh status after removing key
      await refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const hasApiKey = useCallback(async (type: 'stt' | 'llm', providerId: string): Promise<boolean> => {
    try {
      if (tauriInvoke) {
        return await tauriInvoke('has_provider_api_key', {
          providerType: type,
          providerId,
        }) as boolean;
      }
      return false;
    } catch (e) {
      console.error('[useProviders] Failed to check API key:', e);
      return false;
    }
  }, []);

  // ============================================================================
  // Connection Testing
  // ============================================================================
  
  const testConnection = useCallback(async (
    type: 'stt' | 'llm',
    providerId: string
  ): Promise<ConnectionTestResult> => {
    setIsTestingConnection(true);
    setLastTestResult(null);
    setError(null);
    
    try {
      if (!tauriInvoke) {
        const result: ConnectionTestResult = {
          success: false,
          error: 'Tauri not available',
        };
        setLastTestResult(result);
        return result;
      }
      
      const result = await tauriInvoke('test_provider_connection', {
        request: {
          providerType: type,
          providerId,
        },
      }) as ConnectionTestResult;
      
      setLastTestResult(result);
      return result;
    } catch (e) {
      const result: ConnectionTestResult = {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
      setLastTestResult(result);
      return result;
    } finally {
      setIsTestingConnection(false);
    }
  }, []);

  // ============================================================================
  // Provider Status
  // ============================================================================
  
  const refreshStatus = useCallback(async () => {
    try {
      if (tauriInvoke) {
        const status = await tauriInvoke('get_providers_status') as ProvidersStatusResponse;
        if (status) {
          setProvidersStatus(status);
        }
      }
    } catch (e) {
      console.error('[useProviders] Failed to refresh status:', e);
    }
  }, []);

  // ============================================================================
  // Error Handling
  // ============================================================================
  
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // ============================================================================
  // Return
  // ============================================================================
  
  return {
    // Loading states
    isLoading,
    isInitialized,
    
    // STT Settings
    sttSettings,
    setSttSettings,
    updateSttProvider,
    
    // LLM Settings
    llmSettings,
    setLlmSettings,
    updateLlmProvider,
    
    // API Keys
    setApiKey,
    removeApiKey,
    hasApiKey,
    
    // Connection Testing
    testConnection,
    isTestingConnection,
    lastTestResult,
    
    // Provider Status
    providersStatus,
    refreshStatus,
    
    // Errors
    error,
    clearError,
  };
}

export default useProviders;
