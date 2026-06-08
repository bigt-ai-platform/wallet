import { AbstractResponse } from './AbstractResponse';
import { JsonProperty } from "jackson-js";

export class UserDataResponse extends AbstractResponse {
    @JsonProperty() private dataList: string[] | null = null;

    public static createUserDataResponse(dataList: string[]): UserDataResponse {
        const res = new UserDataResponse();
        res.dataList = dataList;
        return res;
    }

    public getDataList(): string[] | null {
        return this.dataList;
    }

    public setDataList(dataList: string[] | null): void {
        this.dataList = dataList;
    }
}
