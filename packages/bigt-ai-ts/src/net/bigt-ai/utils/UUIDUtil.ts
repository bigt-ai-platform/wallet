// TypeScript translation of UUIDUtil.java

export class UUIDUtil {
    static randomUUID(): string {
        // Generates a UUID v4 and removes dashes
        // Use crypto API for secure random UUID
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            const uuid = ([1e7] as any + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: string) =>
                (parseInt(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> (parseInt(c) / 4)).toString(16)
            );
            return uuid.replace(/-/g, '');
        } else {
            // Fallback for environments without crypto
            let uuid = '';
            for (let i = 0; i < 32; i++) {
                if (i === 8 || i === 12 || i === 16 || i === 20) {
                    uuid += '-';
                }
                uuid += Math.floor(Math.random() * 16).toString(16).toLowerCase();
            }
            return uuid.replace(/-/g, '');
        }
    }
}
