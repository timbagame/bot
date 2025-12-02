import { sweepFees } from "../src/services/fee-sweeper";

async function main() {
  await sweepFees();
}

main().catch((error) => {
  console.error("❌ Fee withdrawal script failed:", error);
  process.exit(1);
});
