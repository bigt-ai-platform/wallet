/**
 * Bigt-Ai utilities and helpers
 *
 * This file provides convenient access to bigt-ai-ts functionality
 * for use throughout the application.
 */

// Import bigt-ai-ts library
import * as BigtAi from 'bigt-ai-ts';

// Re-export for convenience
export * from 'bigt-ai-ts';

/**
 * Initialize bigt-ai with default configuration
 *
 * Example usage:
 * ```typescript
 * import { initBigtAi } from '@/utils/bigt-ai';
 *
 * const config = await initBigtAi();
 * ```
 */
export async function initBigtAi() {
    // Add your initialization logic here
    // This is just a placeholder
    console.log('Bigt-Ai initialized');
    return BigtAi;
}

/**
 * Example helper function
 * Add your bigt-ai-specific utilities here
 */
export function getBigtAiVersion(): string {
    // Return version or other utility functions
    return '1.0.0';
}
