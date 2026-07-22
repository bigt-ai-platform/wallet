import { Platform } from 'react-native';

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
        primary: '#10A37F',
        text: {
            primary: '#000000',
            secondary: '#565869',
            link: '#10A37F',
        },
        success: '#10A37F',
        warning: '#f59e0b',
        error: '#ef4444',
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
        accent: {
            blue: '#3B82F6',
            purple: '#8B5CF6',
            amber: '#F59E0B',
            emerald: '#10B981',
            red: '#EF4444',
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
        primary: '#10A37F',
        text: {
            primary: '#ECECF1',
            secondary: '#C5C5D2',
            link: '#10A37F',
        },
        success: '#10A37F',
        warning: '#f59e0b',
        error: '#ef4444',
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
            blue: '#3B82F6',
            purple: '#8B5CF6',
            amber: '#F59E0B',
            emerald: '#10B981',
            red: '#EF4444',
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
