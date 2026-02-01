import { StyleSheet } from 'react-native-unistyles';
import { lightTheme, darkTheme, breakpoints } from './theme';

const appThemes = {
    light: lightTheme,
    dark: darkTheme
};

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes {}
    export interface UnistylesBreakpoints extends AppBreakpoints {}
}

StyleSheet.configure({
    settings: {
        adaptiveThemes: true,
        CSSVars: true,
    },
    breakpoints,
    themes: appThemes,
});
