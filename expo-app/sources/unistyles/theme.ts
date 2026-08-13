const sharedSpacing = {
    margins: {
        xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24,
    },
    borderRadius: {
        sm: 4, md: 8, lg: 10, xl: 12, xxl: 16,
    },
    iconSize: {
        small: 12, medium: 16, large: 20, xlarge: 24,
    },
} as const;

export const lightTheme = {
    dark: false,
    colors: {
        // Solid green for filled buttons / active states (white text ≈ 4.7:1).
        primary: '#0A8462',
        // Tint used behind the active sidebar item and soft highlights.
        primarySoft: 'rgba(10, 132, 98, 0.12)',
        text: {
            primary: '#000000',
            secondary: '#565869',
            link: '#0A8462',
        },
        // Colored *text* indicators (change %, buy/sell side). Strong on white.
        positive: '#047857',
        negative: '#B91C1C',
        success: '#0A8462',
        warning: '#B45309',
        error: '#B91C1C',
        surface: '#FFFFFF',
        surfacePressed: '#F7F7F8',
        divider: '#E5E5E5',
        border: '#E5E5E5',
        groupped: {
            background: '#F7F7F8',
            surface: '#FFFFFF',
        },
        header: {
            background: '#FFFFFF',
            tint: '#000000',
        },
        // Solid fills (buttons, chips, dots, badges) used with `onPrimary`-like
        // white text. Darkened to Tailwind 600/700 for contrast in both themes.
        accent: {
            blue: '#2563EB',
            purple: '#7C3AED',
            amber: '#B45309',
            emerald: '#047857',
            red: '#B91C1C',
        },
        card: {
            background: '#FFFFFF',
            border: '#E5E5E5',
        },
    },
    ...sharedSpacing,
} as const;

export const darkTheme = {
    dark: true,
    colors: {
        primary: '#0A8462',
        primarySoft: 'rgba(52, 211, 153, 0.16)',
        text: {
            primary: '#ECECF1',
            secondary: '#C5C5D2',
            link: '#34D399',
        },
        // Brighter in dark mode so colored text stays legible on dark surfaces.
        positive: '#34D399',
        negative: '#F87171',
        success: '#34D399',
        warning: '#FBBF24',
        error: '#F87171',
        surface: '#444654',
        surfacePressed: '#343541',
        divider: '#4E4F60',
        border: '#4E4F60',
        groupped: {
            background: '#343541',
            surface: '#444654',
        },
        header: {
            background: '#202123',
            tint: '#ECECF1',
        },
        accent: {
            blue: '#2563EB',
            purple: '#7C3AED',
            amber: '#B45309',
            emerald: '#047857',
            red: '#B91C1C',
        },
        card: {
            background: '#444654',
            border: '#4E4F60',
        },
    },
    ...sharedSpacing,
} as const;

export type AppTheme = typeof lightTheme;

export const breakpoints = {
    xs: 0, sm: 576, md: 768, lg: 992, xl: 1200,
} as const;
