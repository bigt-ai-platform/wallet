/**
 * Bigtangle utilities and helpers
 *
 * This file provides convenient access to bigtangle-ts functionality
 * for use throughout the application.
 */

// Import bigtangle-ts library
import * as Bigtangle from '@bigtangle/bigtangle-ts';

// Re-export for convenience
export * from '@bigtangle/bigtangle-ts';

/**
 * Initialize bigtangle with default configuration
 *
 * Example usage:
 * ```typescript
 * import { initBigtangle } from '@/utils/bigtangle';
 *
 * const config = await initBigtangle();
 * ```
 */
export async function initBigtangle() {
    // Add your initialization logic here
    // This is just a placeholder
    console.log('Bigtangle initialized');
    return Bigtangle;
}

/**
 * Example helper function
 * Add your bigtangle-specific utilities here
 */
export function getBigtangleVersion(): string {
    // Return version or other utility functions
    return '1.0.0';
}
