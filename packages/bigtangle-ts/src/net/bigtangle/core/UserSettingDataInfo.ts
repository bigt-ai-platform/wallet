import { DataClass } from './DataClass';
import { UserSettingData } from './UserSettingData';
import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty, JsonClassType } from "jackson-js";

export class UserSettingDataInfo extends DataClass {
    @JsonProperty()
    @JsonClassType({type: () => [Array, [UserSettingData]]})
    private userSettingDatas: UserSettingData[] = [];

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        try {
            const superBytes = new Uint8Array(super.toByteArray());
            baos.writeBytes(superBytes, 0, superBytes.length);
            baos.writeInt(this.userSettingDatas.length);
            for (const c of this.userSettingDatas) {
                const bytes = new Uint8Array(c.toByteArray());
                baos.writeBytes(bytes, 0, bytes.length);
            }
            baos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return baos.toByteArray();
    }

    public parseDIS(dis: DataInputStream): this {
        super.parseDIS(dis);
        this.userSettingDatas = [];
        const size = dis.readInt();
        for (let i = 0; i < size; i++) {
            this.userSettingDatas.push(new UserSettingData().parseDIS(dis));
        }
        return this;
    }

    public parse(buf: Uint8Array): UserSettingDataInfo {
        const bain = new DataInputStream(new Uint8Array(buf));
        try {
            this.parseDIS(bain);
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return this;
    }

    public getUserSettingDatas(): UserSettingData[] {
        return this.userSettingDatas;
    }

    public setUserSettingDatas(userSettingDatas: UserSettingData[]): void {
        this.userSettingDatas = userSettingDatas;
    }
}
