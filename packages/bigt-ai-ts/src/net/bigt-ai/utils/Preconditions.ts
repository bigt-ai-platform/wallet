export class Preconditions {
    public static checkArgument(expression: boolean, errorMessage?: string): void {
        if (!expression) {
            throw new Error(errorMessage || "IllegalArgumentException");
        }
    }

    public static checkState(expression: boolean, errorMessage?: string): void {
        if (!expression) {
            throw new Error(errorMessage || "IllegalStateException");
        }
    }

    public static checkNotNull<T>(reference: T | null | undefined, errorMessage?: string): T {
        if (reference == null) {
            throw new Error(errorMessage || "NullPointerException");
        }
        return reference;
    }
}
