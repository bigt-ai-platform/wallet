import { NetworkParameters } from '../../params/NetworkParameters';
import { ServerState } from './ServerState';

export class ServerPool {
    private servers: ServerState[] = [];
    protected readonly params: NetworkParameters;
    protected fixservers: string[] | null = null;

    constructor(params: NetworkParameters, fixservers?: string[]) {
        this.params = params;
        if (fixservers) {
            this.fixservers = fixservers;
            for (const fixserver of this.fixservers) {
                try {
                    this.addServer(fixserver);
                } catch (e: any) {
                    console.debug("", e);
                }
            }
        }
    }

    public getServer(): ServerState {
        if (this.servers.length === 0) throw new Error("No servers available");
        return this.servers[0];
    }

    public async addServer(s: string): Promise<void> {
        const time = Date.now();
        const serverState = new ServerState();
        serverState.setServerurl(s);
        serverState.setResponseTime(Date.now() - time);
        this.servers.push(serverState);
    }

    public removeServer(server: string): void {
        for (let i = this.servers.length - 1; i >= 0; i--) {
            const a = this.servers[i];
            if (a.getServerurl() === server) {
                this.servers.splice(i, 1);
            }
        }
    }

    public addServers(serverCandidates: string[]): void {
        this.servers = [];
        for (const s of serverCandidates) {
            try {
                this.addServer(s);
            } catch (e: any) {
                console.debug(e.toString());
            }
        }
    }

    public getServers(): ServerState[] {
        return this.servers;
    }

    public setServers(servers: ServerState[]): void {
        this.servers = servers;
    }
}
