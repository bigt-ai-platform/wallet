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

const bigtangle = await import("bigtangle-ts");
const missingExports = requiredExports.filter((exportName) => !(exportName in bigtangle));

if (missingExports.length > 0) {
  throw new Error(`Missing package exports: ${missingExports.join(", ")}`);
}

console.log(`bigtangle-ts package smoke import passed (${requiredExports.length} exports checked)`);