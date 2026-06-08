export class Mutex {
    private locked = false;
    private queue: (() => void)[] = [];

    public lock(): Promise<void> {
        return new Promise(resolve => {
            if (!this.locked) {
                this.locked = true;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }

    public unlock(): void {
        if (!this.locked) {
            return;
        }
        const next = this.queue.shift();
        if (next) {
            this.locked = true;
            next();
        } else {
            this.locked = false;
        }
    }
}
