import { sweepFees } from "../src/services/fee-sweeper";

export async function withdrawTokenFees(): Promise<void> {
  await sweepFees();
}

if (import.meta.main) {
  withdrawTokenFees().catch((error) => {
    console.error("❌ Fee withdrawal script failed:", error);
    process.exit(1);
  });
}
