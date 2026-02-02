import { useUnistyles } from 'react-native-unistyles';

/**
 * Custom hook to properly resolve themed colors
 * This addresses the issue where theme.colors.text returns an object
 * instead of a simple color string
 */
export const useThemedColors = () => {
  const { theme } = useUnistyles();
  
  // Resolve the appropriate color based on the current theme
  const resolveColor = (colorObj: any): string => {
    if (typeof colorObj === 'string') {
      return colorObj;
    }
    
    // If it's an object with theme-dependent values, pick the appropriate one
    if (colorObj && typeof colorObj === 'object') {
      if ('primary' in colorObj) {
        return colorObj.primary;
      } else if ('light' in colorObj && 'dark' in colorObj) {
        return theme.dark ? colorObj.dark : colorObj.light;
      } else {
        // Return the first available color value
        const keys = Object.keys(colorObj);
        if (keys.length > 0) {
          return colorObj[keys[0]];
        }
      }
    }
    
    // Default fallback
    return '#000000';
  };

  return {
    text: resolveColor(theme.colors.text),
    textSecondary: resolveColor(theme.colors.textSecondary),
    textLink: resolveColor(theme.colors.textLink),
    surface: resolveColor(theme.colors.surface),
    surfacePressed: resolveColor(theme.colors.surfacePressed),
    divider: resolveColor(theme.colors.divider),
    border: resolveColor(theme.colors.border),
    primary: resolveColor(theme.colors.primary),
    headerBackground: resolveColor(theme.colors.header?.background),
    headerTint: resolveColor(theme.colors.header?.tint),
    groupedBackground: resolveColor(theme.colors.groupped?.background),
    groupedSurface: resolveColor(theme.colors.groupped?.surface),
    resolveColor,
  };
};