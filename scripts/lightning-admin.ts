import { fixedFloatConfig } from "../src/services/lightning/fixedfloat";
import { DepositStore } from "../src/services/lightning/store";

const config = fixedFloatConfig();
if (!config) throw new Error("FixedFloat must be configured to read its journal");
const store = new DepositStore(
  config.secret,
  process.env["FIXEDFLOAT_DATABASE_FILE"] ?? "lightning.sqlite",
);
try {
  const [action, id, ...args] = process.argv.slice(2);
  if (action === "list") {
    console.log(
      JSON.stringify(
        store.unresolved().map(({ id, owner, state, order, created }) => ({
          id,
          owner,
          state,
          orderId: order?.id ?? null,
          created,
        })),
        null,
        2,
      ),
    );
  } else if (
    action === "abandon" &&
    id &&
    args.includes("--confirm") &&
    args.includes("--reason")
  ) {
    const reason = args[args.indexOf("--reason") + 1];
    if (!reason || reason.startsWith("--"))
      throw new Error("Provide the evidence for closing this request");
    store.abandonUnknown(id, reason);
    console.log("Unknown request closed; no funds were moved. The user can request a new quote.");
  } else {
    throw new Error(
      "Usage: bun scripts/lightning-admin.ts list | abandon <id> --confirm --reason <provider evidence>",
    );
  }
} finally {
  store.close();
}
