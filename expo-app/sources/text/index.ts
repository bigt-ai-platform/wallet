import { getLocales } from 'expo-localization';
import en from './translations/en';

const translations = {
    en,
};

type Translations = typeof translations;

let currentLanguage: keyof Translations = 'en';

// Initialize with device locale if available
const deviceLocale = getLocales()[0]?.languageCode;
if (deviceLocale && deviceLocale in translations) {
    currentLanguage = deviceLocale as keyof Translations;
}

type NestedKeyOf<ObjectType extends object> = {
    [Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object
        ? `${Key}` | `${Key}.${NestedKeyOf<ObjectType[Key]>}`
        : `${Key}`;
}[keyof ObjectType & (string | number)];

type TranslationKey = NestedKeyOf<typeof en>;

function getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
}

export function t(key: TranslationKey, ...params: any[]): string {
    const translation = getNestedValue(translations[currentLanguage], key);
    if (typeof translation === 'function') {
        return translation(...params);
    }
    return translation || key;
}

export function setLanguage(language: keyof Translations) {
    currentLanguage = language;
}

export function getCurrentLanguage() {
    return currentLanguage;
}
