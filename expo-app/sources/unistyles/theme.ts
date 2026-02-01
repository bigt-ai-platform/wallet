import { Platform } from 'react-native';

// Shared spacing, sizing constants
const sharedSpacing = {
    margins: {
        xs: 4,
        sm: 8,
        md: 12,
        lg: 16,
        xl: 20,
        xxl: 24,
    },
    borderRadius: {
        sm: 4,
        md: 8,
        lg: 10,
        xl: 12,
        xxl: 16,
    },
    iconSize: {
        small: 12,
        medium: 16,
        large: 20,
        xlarge: 24,
    },
} as const;

export const lightTheme = {
    dark: false,
    colors: {
        primary: '#2BACCC',
        text: {
            primary: '#000000',
            secondary: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
            link: '#2BACCC',
        },
        textSecondary: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
        textLink: '#2BACCC',
        surface: '#ffffff',
        surfacePressed: '#f0f0f2',
        divider: '#eaeaea',
        border: '#d1d1d6',
        groupped: {
            background: Platform.select({ ios: '#F2F2F7', default: '#F5F5F5' }),
            surface: '#ffffff',
        },
        header: {
            background: '#ffffff',
            tint: '#18171C'
        },
    },
    ...sharedSpacing,
} as const;

export const darkTheme = {
    dark: true,
    colors: {
        primary: '#2BACCC',
        text: {
            primary: '#FFFFFF',
            secondary: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
            link: '#2BACCC',
        },
        textSecondary: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
        textLink: '#2BACCC',
        surface: '#1C1C1E',
        surfacePressed: '#2C2C2E',
        divider: '#38383A',
        border: '#38383A',
        groupped: {
            background: Platform.select({ ios: '#000000', default: '#121212' }),
            surface: '#1C1C1E',
        },
        header: {
            background: '#1C1C1E',
            tint: '#FFFFFF'
        },
    },
    ...sharedSpacing,
} as const;

export type AppTheme = typeof lightTheme;

export const breakpoints = {
    xs: 0,
    sm: 576,
    md: 768,
    lg: 992,
    xl: 1200,
} as const;
