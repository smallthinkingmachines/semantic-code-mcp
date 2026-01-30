/**
 * GPU detection utilities for semantic-code-mcp.
 *
 * Provides auto-detection of GPU availability with environment variable overrides
 * for forcing CPU or CUDA mode.
 */

export type DeviceType = 'auto' | 'cpu' | 'cuda';

export interface DeviceConfig {
  /** The device to use for model inference */
  device: DeviceType;
  /** Human-readable explanation of why this device was selected */
  reason: string;
}

/**
 * Detect the appropriate device for model inference.
 *
 * Device selection priority:
 * 1. SEMANTIC_CODE_FORCE_CPU=1 - Forces CPU usage
 * 2. SEMANTIC_CODE_FORCE_GPU=1 - Forces CUDA GPU usage
 * 3. Default: 'auto' - Let transformers.js detect available hardware
 *
 * @returns Device configuration with device type and reason
 *
 * @example
 * ```typescript
 * const { device, reason } = detectDevice();
 * console.log(`Using device: ${device} (${reason})`);
 *
 * const pipeline = await pipeline('feature-extraction', model, { device });
 * ```
 */
export function detectDevice(): DeviceConfig {
  if (process.env.SEMANTIC_CODE_FORCE_CPU === '1') {
    return {
      device: 'cpu',
      reason: 'CPU forced via SEMANTIC_CODE_FORCE_CPU',
    };
  }

  if (process.env.SEMANTIC_CODE_FORCE_GPU === '1') {
    return {
      device: 'cuda',
      reason: 'CUDA forced via SEMANTIC_CODE_FORCE_GPU',
    };
  }

  return {
    device: 'auto',
    reason: 'Auto-detection (GPU if available, CPU fallback)',
  };
}

/**
 * Get the current device configuration.
 * Convenience function for logging.
 */
export function getDeviceInfo(): string {
  const { device, reason } = detectDevice();
  return `Device: ${device} (${reason})`;
}
