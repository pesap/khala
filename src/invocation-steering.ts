import { nanoid } from "nanoid";

const MAX_STEERS = 200;
const MAX_STEER_LENGTH = 4_000;
const MAX_INVOCATION_TEXT = MAX_STEERS * MAX_STEER_LENGTH;

export type SteeringReceipt = Readonly<{
	id: string;
	text: string;
	status: "queued" | "inserted" | "not-inserted";
}>;

type MutableReceipt = { id: string; text: string; status: SteeringReceipt["status"] };
type Receiver = Readonly<{ kind: "open"; signal: AbortSignal | undefined }> | Readonly<{ kind: "closed" }>;

/** Input belongs to one invocation and is never carried into a replacement. */
export class InvocationSteering {
	private readonly receipts: MutableReceipt[] = [];
	private receiver: Receiver;
	private acceptedCharacters = 0;
	private readonly eligible: () => boolean;

	constructor(eligible: () => boolean = () => true, signal?: AbortSignal) {
		if (signal?.aborted === true) throw new Error("The invocation cannot accept steering.");
		this.eligible = eligible;
		this.receiver = { kind: "open", signal };
	}

	enqueue(text: string): SteeringReceipt {
		if (!this.canDeliver()) throw new Error("The invocation cannot accept steering or has settled.");
		this.validateText(text);
		this.reserveSlot();
		this.acceptedCharacters += text.length;
		const receipt: MutableReceipt = { id: nanoid(), text, status: "queued" };
		this.receipts.push(receipt);
		return { ...receipt };
	}

	private validateText(text: string): void {
		if (text.trim().length === 0) throw new Error("Steering text is required.");
		if (text.length > MAX_STEER_LENGTH) throw new Error(`Steering text exceeds ${MAX_STEER_LENGTH} characters.`);
		if (this.acceptedCharacters + text.length > MAX_INVOCATION_TEXT)
			throw new Error("The invocation's steering text limit is exhausted.");
	}

	private reserveSlot(): void {
		if (this.receipts.length < MAX_STEERS) return;
		const completed = this.receipts.findIndex((receipt) => receipt.status !== "queued");
		if (completed < 0) throw new Error("The invocation's steering queue is full.");
		this.receipts.splice(completed, 1);
	}

	pending(): readonly SteeringReceipt[] {
		if (!this.canDeliver()) return [];
		return this.receipts.filter((receipt) => receipt.status === "queued").map((receipt) => ({ ...receipt }));
	}

	private canDeliver(): boolean {
		if (this.receiver.kind === "closed") return false;
		if (this.isEligible(this.receiver.signal)) return true;
		this.close();
		return false;
	}

	private isEligible(signal: AbortSignal | undefined): boolean {
		try {
			return signal?.aborted !== true && this.eligible();
		} catch {
			return false;
		}
	}

	markInserted(ids: readonly string[]): void {
		const inserted = new Set(ids);
		for (const receipt of this.receipts) {
			if (receipt.status === "queued" && inserted.has(receipt.id)) receipt.status = "inserted";
		}
	}

	close(): void {
		this.receiver = { kind: "closed" };
		for (const receipt of this.receipts) {
			if (receipt.status === "queued") receipt.status = "not-inserted";
		}
	}

	snapshot(): readonly SteeringReceipt[] {
		this.canDeliver();
		return this.receipts.map((receipt) => ({ ...receipt }));
	}
}
