import { DataClass } from './DataClass';
import { Contact } from './Contact';
import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty, JsonClassType } from "jackson-js";

export class ContactInfo extends DataClass {
    @JsonProperty()
    @JsonClassType({type: () => [Array, [Contact]]})
    private contactList: Contact[] = [];

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        try {
            baos.write(new Uint8Array(super.toByteArray()));
            baos.writeInt(this.contactList.length);
            for (const c of this.contactList) {
                baos.write(new Uint8Array(c.toByteArray()));
            }
            baos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return baos.toByteArray();
    }

    public parseDIS(dis: DataInputStream): this {
        super.parseDIS(dis);
        this.contactList = [];
        const size = dis.readInt();
        for (let i = 0; i < size; i++) {
            this.contactList.push(new Contact().parseDIS(dis));
        }
        return this;
    }

    public parse(buf: Uint8Array): ContactInfo {
        const bain = new DataInputStream(new Uint8Array(buf));
        try {
            this.parseDIS(bain);
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return this;
    }

    public getContactList(): Contact[] {
        return this.contactList;
    }

    public setContactList(contactList: Contact[]): void {
        this.contactList = contactList;
    }
}
