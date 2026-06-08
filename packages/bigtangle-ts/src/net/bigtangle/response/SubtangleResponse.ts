import { AbstractResponse } from './AbstractResponse';
import { JsonProperty } from "jackson-js";

export class SubtangleResponse extends AbstractResponse {
    @JsonProperty() private subtanglePermissionList: Map<string, string>[] | null = null;

    public static createUserDataResponse(subtanglePermissionList: Map<string, string>[]): SubtangleResponse {
        const res = new SubtangleResponse();
        res.subtanglePermissionList = subtanglePermissionList;
        return res;
    }

    public getSubtanglePermissionList(): Map<string, string>[] | null {
        return this.subtanglePermissionList;
    }

    public setSubtanglePermissionList(subtanglePermissionList: Map<string, string>[] | null): void {
        this.subtanglePermissionList = subtanglePermissionList;
    }
}
