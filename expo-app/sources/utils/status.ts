type StatusTheme = {
    colors: {
        accent: {
            emerald: string;
            red: string;
            amber: string;
        };
    };
};

const CONFIRMED = new Set(['CONFIRMED', 'FILLED', 'COMPLETED']);
const FAILED = new Set(['FAILED', 'CANCELLED', 'CANCELED', 'DROPPED', 'REJECTED', 'INVALID']);

/**
 * Map a transaction/order status to a badge background color (white text on
 * top). Confirmed → emerald, failed/cancelled → red, otherwise pending → amber.
 */
export function statusBadgeColor(status: string | undefined | null, theme: StatusTheme): string {
    const s = (status || '').toUpperCase();
    if (CONFIRMED.has(s)) return theme.colors.accent.emerald;
    if (FAILED.has(s)) return theme.colors.accent.red;
    return theme.colors.accent.amber;
}
