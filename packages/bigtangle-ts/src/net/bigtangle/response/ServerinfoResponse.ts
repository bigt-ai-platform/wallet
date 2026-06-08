import { AbstractResponse } from './AbstractResponse';
import { ServerInfo } from './ServerInfo';
import { JsonProperty } from "jackson-js";

export class ServerinfoResponse extends AbstractResponse {
    @JsonProperty() private serverInfoList: ServerInfo[] | null = null;

    public static create(serverInfoList: ServerInfo[]): ServerinfoResponse {
        const res = new ServerinfoResponse();
        res.serverInfoList = serverInfoList;
        return res;
    }

    public getServerInfoList(): ServerInfo[] | null {
        return this.serverInfoList;
    }

    public setServerInfoList(serverInfoList: ServerInfo[] | null): void {
        this.serverInfoList = serverInfoList;
    }
}
