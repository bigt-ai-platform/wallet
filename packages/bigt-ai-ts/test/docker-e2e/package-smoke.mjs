const requiredExports = [
  "Address",
  "Block",
  "Coin",
  "ECKey",
  "Sha256Hash",
  "Transaction",
  "Utils",
  "Wallet",
];

const bigtAi = await import("bigt-ai-ts");
const missingExports = requiredExports.filter((exportName) => !(exportName in bigtAi));

if (missingExports.length > 0) {
  throw new Error(`Missing package exports: ${missingExports.join(", ")}`);
}

console.log(`bigt-ai-ts package smoke import passed (${requiredExports.length} exports checked)`);