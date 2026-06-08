export class ServerState {
    public serverurl: string | null = null;
    public status: string | null = null;
    public chainlength: number | null = null;
    public responseTime: number | null = null;

    public getServerurl(): string | null {
        return this.serverurl;
    }

    public setServerurl(serverurl: string | null): void {
        this.serverurl = serverurl;
    }

    public getStatus(): string | null {
        return this.status;
    }

    public setStatus(status: string | null): void {
        this.status = status;
    }

    public getChainlength(): number | null {
        return this.chainlength;
    }

    public setChainlength(chainlength: number | null): void {
        this.chainlength = chainlength;
    }

    public getResponseTime(): number | null {
        return this.responseTime;
    }

    public setResponseTime(responseTime: number | null): void {
        this.responseTime = responseTime;
    }

    public toString(): string {
        return `ServerState [serverurl=${this.serverurl}, status=${this.status}, chainlength=${this.chainlength}` +
               `, responseTime=${this.responseTime}]`;
    }

    public hashCode(): number {
        const prime = 31;
        let result = 1;
        result = prime * result + (this.chainlength == null ? 0 : this.numberHashCode(this.chainlength));
        result = prime * result + (this.responseTime == null ? 0 : this.numberHashCode(this.responseTime));
        result = prime * result + (this.serverurl == null ? 0 : this.stringHashCode(this.serverurl));
        result = prime * result + (this.status == null ? 0 : this.stringHashCode(this.status));
        return result;
    }

    private stringHashCode(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    }

    private numberHashCode(num: number): number {
        // For numbers, a simple way to get a hash is to return the number itself
        // or a bitwise operation if you need to ensure it's a 32-bit integer.
        // Given the context, returning the number directly or its integer representation should be fine.
        return num | 0; // Ensure it's a 32-bit integer
    }

    public equals(obj: any): boolean {
        if (this === obj) return true;
        if (obj == null || this.constructor !== obj.constructor) return false;
        const other = obj as ServerState;
        if (this.chainlength == null) {
            if (other.chainlength != null) return false;
        } else if (this.chainlength !== other.chainlength) return false;
        if (this.responseTime == null) {
            if (other.responseTime != null) return false;
        } else if (this.responseTime !== other.responseTime) return false;
        if (this.serverurl == null) {
            if (other.serverurl != null) return false;
        } else if (this.serverurl !== other.serverurl) return false;
        if (this.status == null) {
            if (other.status != null) return false;
        } else if (this.status !== other.status) return false;
        return true;
    }
}
