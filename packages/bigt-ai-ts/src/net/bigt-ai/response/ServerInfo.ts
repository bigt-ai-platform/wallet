import { JsonProperty } from "jackson-js";

export class ServerInfo {
    @JsonProperty() public url: string | null = null;
    @JsonProperty() public servertype: string | null = null;
    @JsonProperty() public chain: string | null = null;
    @JsonProperty() public status: string | null = null;

    public getUrl(): string | null {
        return this.url;
    }

    public setUrl(url: string | null): void {
        this.url = url;
    }

    public getServertype(): string | null {
        return this.servertype;
    }

    public setServertype(servertype: string | null): void {
        this.servertype = servertype;
    }

    public getChain(): string | null {
        return this.chain;
    }

    public setChain(chain: string | null): void {
        this.chain = chain;
    }

    public getStatus(): string | null {
        return this.status;
    }

    public setStatus(status: string | null): void {
        this.status = status;
    }
}
