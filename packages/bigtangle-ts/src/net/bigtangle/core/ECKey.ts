/**
 * @deprecated ECKey has been replaced by PQKey.
 * Use `import { PQKey } from 'bigtangle-ts'` instead.
 */
export class ECKey {
  constructor(..._args: any[]) {
    throw new Error('ECKey is removed. Use PQKey instead.');
  }

  static createNewKey(): never {
    throw new Error('ECKey is removed. Use PQKey.createNew() instead.');
  }

  static fromPrivate(_priv: bigint): never {
    throw new Error('ECKey is removed. Use PQKey.fromKeyMaterial() instead.');
  }

  static fromPrivateString(_priv: string): never {
    throw new Error('ECKey is removed. Use PQKey.fromKeyMaterial() instead.');
  }
}
