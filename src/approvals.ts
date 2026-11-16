import { randomUUID } from "node:crypto";
import type { ApprovalBroker, ApprovalOutcome, ApprovalRequest } from "./fileops.js";

/** The approval broker: an in-memory pending map (ephemeral by design — a
 *  restart simply abandons any blocked run, leaving the file untouched),
 *  exposed to the frontend via ctx.handle so the registerView panel can
 *  list and decide them. Mirrors the native feature's
 *  src/server/workspace-approvals.ts. */

export interface PendingApproval extends ApprovalRequest {
	id: string;
	createdAt: string;
	expiresAt: string;
}

const TIMEOUT_MS = 10 * 60_000;

export function createApprovalBroker(onChange: () => void) {
	const pending = new Map<string, { request: PendingApproval; settle: (o: ApprovalOutcome) => void }>();

	const broker: ApprovalBroker = (request, signal) =>
		new Promise((resolve) => {
			if (signal?.aborted) { resolve({ status: "aborted" }); return; }
			const id = randomUUID();
			const now = Date.now();
			const full: PendingApproval = { ...request, id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + TIMEOUT_MS).toISOString() };
			let settled = false;
			const timer = setTimeout(() => settle({ status: "timeout" }), TIMEOUT_MS);
			const onAbort = () => settle({ status: "aborted" });
			function settle(outcome: ApprovalOutcome) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				pending.delete(id);
				onChange();
				resolve(outcome);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			pending.set(id, { request: full, settle });
			onChange();
		});

	return {
		broker,
		list(): PendingApproval[] {
			return [...pending.values()].map((p) => p.request).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		decide(id: string, approved: boolean): boolean {
			const found = pending.get(id);
			if (!found) return false;
			found.settle(approved ? { status: "approved" } : { status: "denied" });
			return true;
		},
	};
}
